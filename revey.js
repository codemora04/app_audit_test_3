import { supabase } from "./supabase.js";
import { getCurrentAuditPeriod, getAuditPeriodStartDate, compressImage, showLoading, hideLoading, handleSupabaseError } from "./utils.js";

/* ===================== NAVIGATION PROTECTION ===================== */
window.addEventListener("beforeunload", (e) => {
  const zone = document.getElementById("zone")?.value;
  if (zone) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const btnRetour = document.querySelector(".btn-retour-rouge");
if (btnRetour) {
  btnRetour.addEventListener("click", (e) => {
    const zone = document.getElementById("zone")?.value;
    if (zone && !confirm("Un audit est en cours. Voulez-vous vraiment quitter ? Votre progression locale sera conservée mais l'audit ne sera pas finalisé.")) {
      e.preventDefault();
    }
  });
}

/* ===================== SESSION CHECK ===================== */
const { data: sessionWrap } = await supabase.auth.getSession();
if (!sessionWrap?.session) window.location.href = "login.html";

/* ===================== LOAD DICT FROM SUPABASE ===================== */
async function loadDict(name) {
  const { data, error } = await supabase
    .from("app_data")
    .select("data")
    .eq("name", name)
    .single();

  if (error) {
    console.error("Cannot load", name, error.message);
    alert("Erreur: impossible de charger les données depuis Supabase.");
    return null;
  }
  return data?.data ?? null;
}

const DICT_REVEY = await loadDict("DICT_REVEY");
console.log("DICT_REVEY:", DICT_REVEY);
if (!DICT_REVEY) throw new Error("DICT_REVEY not loaded");

/* ===================== DOM ===================== */
const atelierSelect = document.getElementById("atelier");

const auditContainer = document.getElementById("audit-container");
const auditSelect = document.getElementById("audit");

const zoneContainer = document.getElementById("zone-container");
const zoneSelect = document.getElementById("zone");

const rubriqueContainer = document.getElementById("rubrique-container");
const rubriquesList = document.getElementById("rubriques-list");

const downloadBtn = document.getElementById("downloadPdf");
const downloadScoreBtn = document.getElementById("downloadScoreBtn");

const userId = (await supabase.auth.getUser()).data.user?.id;
const username = localStorage.getItem("username") || "";

/* ===================== DB STATE ===================== */
let currentSessionId = null;

/* ===================== PAGE STATE (persist across refresh) ===================== */
const STATE_KEY = "revey_state";

function saveState() {
  const state = {
    atelier: atelierSelect.value,
    audit: auditSelect.value,
    zone: zoneSelect.value,
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STATE_KEY);
}

async function restoreState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return;

  let state;
  try { state = JSON.parse(raw); } catch { return; }

  const { atelier, audit, zone } = state;
  if (!atelier) return;

  // Restore atelier
  atelierSelect.value = atelier;
  if (!atelierSelect.value) return;

  // Rebuild audits
  const auditsObj = DICT_REVEY?.[atelier] || {};
  resetSelect(auditSelect);
  Object.keys(auditsObj).forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    auditSelect.appendChild(opt);
  });
  auditContainer?.classList.remove("hidden");

  if (!audit) return;
  auditSelect.value = audit;
  if (!auditSelect.value) return;

  // Rebuild zones
  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  resetSelect(zoneSelect);
  Object.keys(zonesObj).forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });
  zoneContainer?.classList.remove("hidden");
  refreshSelectsProgress();

  if (!zone) return;
  zoneSelect.value = zone;
  if (!zoneSelect.value) return;

  const zoneData = DICT_REVEY?.[atelier]?.[audit]?.[zone];
  if (!zoneData) return;

  let rubriquesObj = zoneData;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(atelier, audit, zone);
    const existing = await getExistingAnswers(currentSessionId);
    showRubriques(rubriquesObj, existing);
  } catch (e) { console.error(e); }
  finally { hideLoading(); }

  refreshSelectsProgress();
}

/* ===================== HELPERS ===================== */
function resetSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = `<option value="">--Choisir--</option>`;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function hideAllBelowAtelier() {
  auditContainer?.classList.add("hidden");
  zoneContainer?.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");

  resetSelect(auditSelect);
  resetSelect(zoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";
  document.getElementById("progress-root")?.classList.add("hidden");
  document.getElementById("summary-section")?.classList.add("hidden");
}

/* ===================== ROW COMPLETION + COLOR ===================== */
function isRowComplete(tr) {
  const statusEl = tr.querySelector("select");
  const commentEl = tr.querySelector('input[type="text"]');
  const fileEl = tr.querySelector('input[type="file"]');

  const status = statusEl?.value || "";
  const comment = commentEl?.value?.trim() || "";
  const hasFile = fileEl?.files && fileEl.files.length > 0;

  if (status === "") return false;
  if (comment === "") return false;

  // Image mandatory ONLY for: Acceptable(2), Unsatisfactory(3), Non(non)
  const imageMandatory = ["2", "3", "non"].includes(status);

  if (imageMandatory && !hasFile) return false;

  return true;
}

function updateRowColor(tr) {
  if (!tr) return;
  if (isRowComplete(tr)) tr.classList.add("row-complete");
  else tr.classList.remove("row-complete");
}

/* ===================== PROGRESSION TRACKING ===================== */
function getProgressKey(atelier, audit, zone) {
  const period = getCurrentAuditPeriod(audit);
  return `prog_${username}_${period}_${atelier}_${audit}_${zone}`;
}

function updateProgressState(atelier, audit, zone, completedObj) {
  if (!atelier || !audit || !zone) return;
  const key = getProgressKey(atelier, audit, zone);
  localStorage.setItem(key, JSON.stringify(completedObj));
}

function getProgressState(atelier, audit, zone) {
  if (!atelier || !audit || !zone) return null;
  const key = getProgressKey(atelier, audit, zone);
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
}

function refreshSelectsProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zoneOptions = zoneSelect.options;
  for (let i = 1; i < zoneOptions.length; i++) {
    const opt = zoneOptions[i];
    const zName = opt.value;

    const state = getProgressState(atelier, audit, zName);
    if (state && state.completed === state.total && state.total > 0) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + zName;
    } else {
      opt.textContent = zName;
    }
  }
}

function computeViewProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  if (!atelier || !audit || !zone) return;

  const tables = rubriquesList.querySelectorAll("table.questions-table");
  let totalRows = 0;
  let completedRows = 0;

  tables.forEach(table => {
    const rows = table.querySelectorAll("tbody tr");
    totalRows += rows.length;
    rows.forEach(tr => {
      if (isRowComplete(tr)) completedRows++;
    });
  });
  console.log(completedRows, totalRows);

  updateProgressState(atelier, audit, zone, { total: totalRows, completed: completedRows });

  // Update Progress Bar
  const progressRoot = document.getElementById("progress-root");
  const progressFill = document.getElementById("progress-fill");
  const progressPercent = document.getElementById("progress-percent");

  if (progressRoot && totalRows > 0) {
    progressRoot.classList.remove("hidden");
    const percent = Math.round((completedRows / totalRows) * 100);
    progressFill.style.width = percent + "%";
    progressPercent.textContent = percent + "%";
  }

  // Update Summary if full
  if (totalRows > 0 && completedRows === totalRows) {
    showSummary();
  } else {
    document.getElementById("summary-section")?.classList.add("hidden");
  }

  refreshSelectsProgress();
  computeGlobalProgress();
}

let debounceTimerId = null;

async function computeGlobalProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const totalQuestions = getAuditTotalQuestions(atelier, audit);
  if (totalQuestions === 0) return;

  clearTimeout(debounceTimerId);
  debounceTimerId = setTimeout(async () => {
    try {
      const fullAuditName = `${atelier} — ${audit}`;
      const periodStartDate = getAuditPeriodStartDate(audit);
      const { data: sessions } = await supabase
        .from("audit_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("audit", fullAuditName)
        .gte("created_at", periodStartDate);

      let completedCount = 0;
      if (sessions && sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        const { count } = await supabase
          .from("audit_answers")
          .select("*", { count: 'exact', head: true })
          .in("session_id", sessionIds);
        completedCount = count || 0;
      }

      const progressRoot = document.getElementById("progress-root");
      const progressFill = document.getElementById("progress-fill");
      const progressPercent = document.getElementById("progress-percent");

      if (progressRoot) {
        progressRoot.classList.remove("hidden");
        const percent = Math.min(100, Math.round((completedCount / totalQuestions) * 100));
        progressFill.style.width = percent + "%";
        progressPercent.textContent = percent + "%";
      }
    } catch (e) {
      console.error("Global progress err:", e);
    }
  }, 1500);
}

function getAuditTotalQuestions(atelierName, auditName) {
  const auditData = DICT_REVEY[atelierName]?.[auditName];
  if (!auditData) return 0;
  let total = 0;

  for (const zone in auditData) {
    const zoneData = auditData[zone];
    if (Array.isArray(zoneData)) {
      total += zoneData.length;
      continue;
    }
    const values = Object.values(zoneData || {});
    const isDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

    if (isDirectRubriques) {
      for (const rub in zoneData) total += (zoneData[rub] || []).length;
      continue;
    }

    for (const souszone in zoneData) {
      const rubriques = zoneData[souszone];
      if (Array.isArray(rubriques)) total += rubriques.length;
      else if (typeof rubriques === 'object') {
        for (const rub in rubriques) total += (rubriques[rub] || []).length;
      }
    }
  }
  return total;
}

function showSummary() {
  const summarySection = document.getElementById("summary-section");
  const summaryBody = document.getElementById("summary-body");
  if (!summarySection || !summaryBody) return;

  summaryBody.innerHTML = "";
  const rubriques = rubriquesList.querySelectorAll(".rubrique-header");
  let globalGood = 0;
  let globalTotal = 0;
  const safety = isSafetyAuditSelected();

  rubriques.forEach(header => {
    const title = header.textContent.replace(/[▶▼0-9]/g, "").trim();
    const wrapper = header.nextElementSibling;
    const rows = wrapper.querySelectorAll("tbody tr");
    let good = 0;
    let applicable = 0;

    rows.forEach(tr => {
      const val = tr.querySelector("select")?.value;
      if (!val) return; // Skip empty
      
      if (safety) {
        if (val === "na") return; // Ignorer "non applicable"
        applicable++;
        if (val === "oui") good++;
      } else {
        applicable++;
        if (val === "1" || val === "oui") good++;
      }
    });

    const score = applicable > 0 ? Math.round((good / applicable) * 100) : 0;
    globalGood += good;
    globalTotal += applicable;

    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${title}</td><td style="text-align:right; font-weight:bold;">${score}%</td>`;
    summaryBody.appendChild(tr);
  });

  if (globalTotal > 0) {
    const avg = Math.round((globalGood / globalTotal) * 100);
    const trFinal = document.createElement("tr");
    trFinal.innerHTML = `<td>TOTAL GLOBAL</td><td style="text-align:right; font-weight:bold;">${avg}%</td>`;
    summaryBody.appendChild(trFinal);
  } else {
    const trFinal = document.createElement("tr");
    trFinal.innerHTML = `<td>TOTAL GLOBAL</td><td style="text-align:right; font-weight:bold;">0%</td>`;
    summaryBody.appendChild(trFinal);
  }

  summarySection.classList.remove("hidden");
}

/* ===================== POPULATE ATELIERS ===================== */
resetSelect(atelierSelect);
Object.keys(DICT_REVEY || {}).forEach((atelier) => {
  const opt = document.createElement("option");
  opt.value = atelier;
  opt.textContent = atelier;
  atelierSelect.appendChild(opt);
});

atelierSelect.addEventListener("change", () => {
  hideAllBelowAtelier();
  clearState();

  const atelier = atelierSelect.value;
  if (!atelier) return;

  const auditsObj = DICT_REVEY?.[atelier] || {};
  const audits = Object.keys(auditsObj);

  resetSelect(auditSelect);
  audits.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    auditSelect.appendChild(opt);
  });

  auditContainer?.classList.remove("hidden");
  saveState();
});


auditSelect.addEventListener("change", async () => {
  zoneContainer?.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");

  resetSelect(zoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  const zones = Object.keys(zonesObj);

  zones.forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });

  zoneContainer?.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();

  currentSessionId = null; // Session logic moved to zones
});


zoneSelect.addEventListener("change", async () => {
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  if (!atelier || !audit || !zone) return;

  const zoneData = DICT_REVEY?.[atelier]?.[audit]?.[zone];
  if (!zoneData) return;

  let rubriquesObj = zoneData;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(atelier, audit, zone);
    const existing = await getExistingAnswers(currentSessionId);
    showRubriques(rubriquesObj, existing);
  } catch (e) { handleSupabaseError(e, "Erreur"); }
  finally { hideLoading(); }

  refreshSelectsProgress();
  saveState();
});

await restoreState();

/* ===================== DB HELPERS ===================== */
function safeUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getOrCreateAuditSession(atelier, audit, zone) {
  const fullAuditName = `${atelier} — ${audit}`;
  const periodStartDate = getAuditPeriodStartDate(audit);

  let query = supabase
    .from("audit_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("audit", fullAuditName)
    .gte("created_at", periodStartDate);

  if (zone) query = query.eq("zone", zone);
  else query = query.is("zone", null);

  const { data: existing, error: errFetch } = await query.limit(1);
  if (errFetch) throw errFetch;

  if (existing && existing.length > 0) {
    currentSessionId = existing[0].id;
    return currentSessionId;
  }

  const { data: newSession, error: errInsert } = await supabase
    .from("audit_sessions")
    .insert({
      user_id: userId,
      audit: fullAuditName,
      zone: zone || null,
      souszone: null,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (errInsert) throw errInsert;
  currentSessionId = newSession.id;
  return newSession.id;
}

async function getExistingAnswers(sessionId) {
  if (!sessionId) return [];
  const { data, error } = await supabase
    .from("audit_answers")
    .select("*")
    .eq("session_id", sessionId);

  if (error) {
    console.error("Erreur chargement réponses:", error);
    return [];
  }
  return data || [];
}

async function uploadImageToStorage(file) {
  if (!file) return "";
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const filePath = `image_url/${safeUUID()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from("audit-images")
    .upload(filePath, file, { upsert: true });

  if (upErr) throw upErr;

  const { data } = supabase.storage.from("audit-images").getPublicUrl(filePath);
  return data.publicUrl || "";
}

async function saveAnswer({ rubriqueTitle, question, statusLabel, comment, file }) {
  if (!currentSessionId) return;

  let image_url = null;
  try {
    if (file) {
      const compressedFile = await compressImage(file);
      const url = await uploadImageToStorage(compressedFile);
      image_url = url || null;
    }
  } catch (e) {
    handleSupabaseError(e, "Erreur upload image");
    return;
  }

  const { error } = await supabase
    .from("audit_answers")
    .upsert(
      {
        session_id: currentSessionId,
        rubrique: rubriqueTitle,
        question: question,
        status: statusLabel,
        comment: comment,
        image_url: image_url,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id,rubrique,question" }
    );

  if (error) handleSupabaseError(error, "Erreur sauvegarde réponse");
}
function isSafetyAuditSelected() {
  const val = auditSelect?.value?.toLowerCase() || "";
  return val.includes("safety") || val.includes("anomalie");
}

function statusValueToLabel(value) {
  if (isSafetyAuditSelected()) {
    if (value === "oui") return "Oui";
    if (value === "non") return "Non";
    if (value === "na") return "Non applicable";
    return "";
  } else {
    if (value === "1") return "Good";
    if (value === "2") return "Acceptable";
    if (value === "3") return "Unsatisfactory";
    return "";
  }
}

/* ===================== SHOW RUBRIQUES ===================== */
function showRubriques(rubriquesObj, existingAnswers = []) {
  const ansMap = {};
  existingAnswers.forEach(a => ansMap[`${a.rubrique}|${a.question}`] = a);

  function mapStatusVal(statusLabel) {
    const isSafety = isSafetyAuditSelected();
    if (isSafety) {
      if (statusLabel === "Oui") return "oui";
      if (statusLabel === "Non") return "non";
      if (statusLabel === "Non applicable") return "na";
      return "";
    }
    if (statusLabel === "Good" || statusLabel === "Oui") return "1"; // "Oui" is for backward compat
    if (statusLabel === "Acceptable") return "2";
    if (statusLabel === "Unsatisfactory" || statusLabel === "Non") return "3"; // "Non" is for backward compat
    return "";
  }
  rubriquesList.innerHTML = "";

  // ✅ CAS 1 : directement un tableau de questions (pas de rubrique)
  if (Array.isArray(rubriquesObj)) {
    const header = document.createElement("div");
    header.className = "rubrique-header";
    header.innerHTML = "Questions";

    const tableWrapper = document.createElement("div");
    tableWrapper.className = "rubrique-table-wrapper";

    const table = document.createElement("table");
    table.className = "questions-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Question</th>
          <th>Status</th>
          <th>Commentaire</th>
          <th>Image</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    rubriquesObj.forEach((q, qIndex) => {
      const tr = document.createElement("tr");

      let statusOptions = `<option value="">--</option>`;
      const auditSelect = document.getElementById("audit");
      const audit = auditSelect?.value || "";
      const isSafety = audit.toLowerCase().includes("safety") || audit.toLowerCase().includes("anomalie");

      if (isSafety) {
        statusOptions += `
          <option value="oui">Oui</option>
          <option value="non">Non</option>
          <option value="na">Non applicable</option>
        `;
      } else {
        statusOptions += `
          <option value="1">Good</option>
          <option value="2">Acceptable</option>
          <option value="3">Unsatisfactory</option>
        `;
      }

      tr.innerHTML = `
        <td>${q}</td>
        <td>
          <select name="status_0_${qIndex}">
            ${statusOptions}
          </select>
        </td>
        <td>
          <input type="text" name="comment_0_${qIndex}" placeholder="Commentaire..." />
        </td>
        <td>
          <input type="file" name="image_0_${qIndex}" accept="image/*" capture="environment" />
        </td>
      `;

      tbody.appendChild(tr);

      const statusEl = tr.querySelector("select");
      const commentEl = tr.querySelector('input[type="text"]');
      const fileEl = tr.querySelector('input[type="file"]');

      const questionText = q;
      const ex = ansMap[`Questions|${questionText}`];

      if (ex) {
        statusEl.value = mapStatusVal(ex.status);
        commentEl.value = ex.comment || "";
        if (ex.image_url) {
          fileEl.insertAdjacentHTML("beforebegin", `<a href="${ex.image_url}" target="_blank" title="Voir l'image actuelle" style="margin-right:10px; font-size:1.4rem; text-decoration:none;">🖼️</a>`);
        }
      }

      const saveAction = async () => {
        const val = statusEl?.value || "";
        const statusLabel = statusValueToLabel(val);
        const comment = commentEl?.value?.trim() || "";
        const file = fileEl?.files?.[0] || null;

        await saveAnswer({
          rubriqueTitle: "Questions",
          question: questionText,
          statusLabel,
          comment,
          file,
        });
      };

      const debouncedSave = debounce(saveAction, 500);

      statusEl.addEventListener("change", () => {
        saveAction();
        updateRowColor(tr);
        computeViewProgress();
      });

      commentEl.addEventListener("input", () => {
        debouncedSave();
        updateRowColor(tr);
        computeViewProgress();
      });

      fileEl.addEventListener("change", () => {
        saveAction();
        updateRowColor(tr);
        computeViewProgress();
      });

      updateRowColor(tr);
    });

    tableWrapper.appendChild(table);
    rubriquesList.appendChild(header);
    rubriquesList.appendChild(tableWrapper);

    rubriqueContainer?.classList.remove("hidden");
    downloadBtn?.classList.remove("hidden");
    downloadScoreBtn?.classList.remove("hidden");
  } else {

  Object.entries(rubriquesObj || {}).forEach(([rubrique, questions], index) => {
    // Header (accordion)
    const header = document.createElement("div");
    header.className = "rubrique-header";
    header.innerHTML = `&#9654; ${rubrique}`;

    // Wrapper
    const tableWrapper = document.createElement("div");
    tableWrapper.className = "rubrique-table-wrapper hidden";

    // Table
    const table = document.createElement("table");
    table.className = "questions-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Question</th>
          <th>Status</th>
          <th>Commentaire</th>
          <th>Image</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector("tbody");

    let extractedQuestions = [];
    if (Array.isArray(questions)) {
      extractedQuestions = questions.map(q => ({ qText: q, trueRubrique: rubrique }));
    } else if (typeof questions === "object" && questions !== null) {
      for (const [subRName, subQs] of Object.entries(questions)) {
        if (Array.isArray(subQs)) {
          extractedQuestions.push({ isSubHeader: true, title: subRName });
          subQs.forEach(q => extractedQuestions.push({ qText: q, trueRubrique: subRName }));
        } else if (typeof subQs === "object" && subQs !== null) {
          for (const [subSub, subSubQs] of Object.entries(subQs)) {
            if (Array.isArray(subSubQs)) {
              extractedQuestions.push({ isSubHeader: true, title: `${subRName} - ${subSub}` });
              subSubQs.forEach(q => extractedQuestions.push({ qText: q, trueRubrique: subSub }));
            }
          }
        }
      }
    }

    extractedQuestions.forEach((item, qIndex) => {
      const tr = document.createElement("tr");

      if (item.isSubHeader) {
        tr.innerHTML = `<td colspan="4" style="background-color: #f1f5f9; font-weight: bold; color: #475569; padding-left: 15px; text-transform: uppercase; font-size: 13px;">${item.title}</td>`;
        tbody.appendChild(tr);
        return; // Passer à l'élément suivant
      }

      const q = item.qText;
      const trueRubriqueTitle = item.trueRubrique;
      const safety = isSafetyAuditSelected();

      let statusOptions = `<option value="">--</option>`;
      if (safety) {
        statusOptions += `
          <option value="oui">Oui</option>
          <option value="non">Non</option>
          <option value="na">Non applicable</option>
        `;
      } else {
        statusOptions += `
          <option value="1">Good</option>
          <option value="2">Acceptable</option>
          <option value="3">Unsatisfactory</option>
        `;
      }

      tr.innerHTML = `
        <td>${q}</td>
        <td>
          <select name="status_${index}_${qIndex}">
            ${statusOptions}
          </select>
        </td>
        <td>
          <input type="text" name="comment_${index}_${qIndex}" placeholder="Commentaire..." />
        </td>
        <td>
          <input type="file" name="image_${index}_${qIndex}" accept="image/*" capture="environment" />
        </td>
      `;

      tbody.appendChild(tr);

      const statusEl = tr.querySelector("select");
      const commentEl = tr.querySelector('input[type="text"]');
      const fileEl = tr.querySelector('input[type="file"]');

      const rubriqueTitle = trueRubriqueTitle;
      const questionText = q;

      // On essaye de récupérer la réponse avec le vrai titre de la rubrique, ou l'ancien (nom de la sous-zone) par rétrocompatibilité
      const ex = ansMap[`${rubriqueTitle}|${questionText}`] || ansMap[`${rubrique}|${questionText}`];
      if (ex) {
        statusEl.value = mapStatusVal(ex.status);
        commentEl.value = ex.comment || "";
        if (ex.image_url) {
          fileEl.insertAdjacentHTML("beforebegin", `<a href="${ex.image_url}" target="_blank" title="Voir l'image actuelle" style="margin-right:10px; font-size:1.4rem; text-decoration:none;">🖼️</a>`);
        }
      }

      const saveAction = async () => {
        const val = statusEl?.value || "";
        const statusLabel = statusValueToLabel(val);
        const comment = commentEl?.value?.trim() || "";
        const file = fileEl?.files?.[0] || null;

        await saveAnswer({
          rubriqueTitle,
          question: questionText,
          statusLabel,
          comment,
          file,
        });
      };

      const debouncedSave = debounce(saveAction, 500);

      statusEl.addEventListener("change", () => {
        saveAction();
        updateRowColor(tr);
        computeViewProgress();
      });

      commentEl.addEventListener("input", () => {
        debouncedSave();
        updateRowColor(tr);
        computeViewProgress();
      });

      fileEl.addEventListener("change", () => {
        saveAction();
        updateRowColor(tr);
        computeViewProgress();
      });

      updateRowColor(tr);
    });

    tableWrapper.appendChild(table);

    // Accordion toggle
    header.addEventListener("click", () => {
      tableWrapper.classList.toggle("hidden");
      header.innerHTML =
        (tableWrapper.classList.contains("hidden") ? "&#9654;" : "&#9660;") + " " + rubrique;
    });

    rubriquesList.appendChild(header);
    rubriquesList.appendChild(tableWrapper);
    });
  }

  // ✅ AJOUT RUBRIQUE "AUTRES"
  const headerAutres = document.createElement("div");
  headerAutres.className = "rubrique-header";
  headerAutres.innerHTML = `&#9654; Autres (Remarques générales)`;

  const wrapperAutres = document.createElement("div");
  wrapperAutres.className = "rubrique-table-wrapper hidden";
  wrapperAutres.style.padding = "15px";

  const textareaAutres = document.createElement("textarea");
  textareaAutres.placeholder = "Saisissez ici vos remarques qui n'appartiennent à aucune rubrique...";
  textareaAutres.style.width = "100%";
  textareaAutres.style.minHeight = "100px";
  textareaAutres.style.borderRadius = "8px";
  textareaAutres.style.border = "1px solid #cbd5e1";
  textareaAutres.style.padding = "10px";
  textareaAutres.style.fontSize = "14px";
  textareaAutres.style.fontFamily = "inherit";

  // Load existing
  const exAutres = ansMap["Autres|Remarques"];
  if (exAutres) {
    textareaAutres.value = exAutres.comment || "";
  }

  const saveAutres = async () => {
    await saveAnswer({
      rubriqueTitle: "Autres",
      question: "Remarques",
      statusLabel: "Information",
      comment: textareaAutres.value.trim(),
      file: null
    });
  };

  textareaAutres.addEventListener("input", debounce(saveAutres, 1000));

  wrapperAutres.appendChild(textareaAutres);
  headerAutres.addEventListener("click", () => {
    wrapperAutres.classList.toggle("hidden");
    headerAutres.innerHTML = (wrapperAutres.classList.contains("hidden") ? "&#9654;" : "&#9660;") + " Autres (Remarques générales)";
  });

  rubriquesList.appendChild(headerAutres);
  rubriquesList.appendChild(wrapperAutres);

  rubriqueContainer?.classList.remove("hidden");
  downloadBtn?.classList.remove("hidden");
  downloadScoreBtn?.classList.remove("hidden");
}

/* ===================== IMAGE COMPRESS ===================== */
async function readImageCompressed(file, maxW = 900, quality = 0.7) {
  if (!file || !file.type.startsWith("image/")) return "";

  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Image illisible"));
    im.src = dataUrl;
  });

  const ratio = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  return canvas.toDataURL("image/jpeg", quality);
}

/* ===================== PDF DOWNLOAD (FULL REPORT) ===================== */
downloadBtn?.addEventListener("click", async () => {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const atelier = atelierSelect?.value || "";
    const audit = auditSelect?.value || "";
    const zone = zoneSelect?.value || "";
    const username = localStorage.getItem("username") || "Auditeur";
    const dateStr = new Date().toLocaleDateString("fr-FR");
    const timeStr = new Date().toLocaleTimeString("fr-FR");

    const colorSlate = [30, 41, 59];
    const colorEmerald = [16, 185, 129];

    const addPageDesign = (pageNum) => {
      // --- En-tête ---
      doc.setFillColor(...colorSlate);
      doc.rect(0, 0, pageWidth, 40, "F");

      try {
        doc.addImage("logo2.png", "PNG", 14, 8, 35, 15);
      } catch (e) {
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16);
        doc.text("REVEY", 14, 18);
      }

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont(undefined, "bold");
      doc.text("RAPPORT D'AUDIT", pageWidth - 14, 18, { align: "right" });

      doc.setFontSize(10);
      doc.setFont(undefined, "normal");
      doc.text(`${atelier} — ${audit}`, pageWidth - 14, 25, { align: "right" });
      doc.text(`Page ${pageNum}`, pageWidth - 14, 32, { align: "right" });

      // --- Pied de page ---
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.1);
      doc.line(14, pageHeight - 15, pageWidth - 14, pageHeight - 15);

      doc.setFontSize(9);
      doc.setTextColor(51, 65, 85);
      doc.setFont(undefined, "normal");
      doc.text(`Généré le ${dateStr} à ${timeStr} par ${username}`, 14, pageHeight - 10);
      doc.text(`Page ${pageNum}`, pageWidth - 14, pageHeight - 10, { align: "right" });
    };

    const generatePDF = async () => {
      showLoading("Génération du rapport PDF consolidé...");
      try {
        const fullAuditName = `${atelier} — ${audit}`;
        const periodStartDate = getAuditPeriodStartDate(audit);

        const { data: sessions } = await supabase
          .from("audit_sessions")
          .select("id, zone, souszone")
          .eq("audit", fullAuditName)
          .eq("user_id", userId)
          .gte("created_at", periodStartDate);

        const answerMap = {};
        const preloadedImages = {};
        const imagePromises = [];

        if (sessions && sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);
          const sessionMap = {};
          sessions.forEach(s => { sessionMap[s.id] = { zone: s.zone }; });

          const { data: answers } = await supabase
            .from("audit_answers")
            .select("*")
            .in("session_id", sessionIds);

          if (answers) {
            answers.forEach(a => {
              const sess = sessionMap[a.session_id];
              if (!sess) return;
              const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;
              answerMap[key] = a;

              if (a.image_url && !a.image_url.includes("undefined")) {
                imagePromises.push(
                  fetch(a.image_url)
                    .then(r => r.blob())
                    .then(blob => {
                      const file = new File([blob], "img.jpg", { type: blob.type });
                      return readImageCompressed(file, 400, 0.7);
                    })
                    .then(img => { preloadedImages[a.id] = img; })
                    .catch(() => {})
                );
              }
            });
          }
        }

        await Promise.all(imagePromises);

        const auditData = DICT_REVEY?.[atelier]?.[audit] || {};
        const tree = {};
        const zoneScores = {};
        let totalGood = 0, totalQ = 0;

        const safety = isSafetyAuditSelected();
        const filterZone = safety;

        for (const [zName, zoneData] of Object.entries(auditData)) {
          if (filterZone && zoneSelect.value && zName !== zoneSelect.value) continue;

          zoneScores[zName] = { good: 0, total: 0 };
          tree[zName] = {};

          const values = (typeof zoneData === "object" && zoneData !== null) ? Object.values(zoneData) : [];
          const isDirectQs = Array.isArray(zoneData);
          const isDirectRub = values.length > 0 && values.every(v => Array.isArray(v));

          if (isDirectQs || isDirectRub) {
            tree[zName]["Questions"] = {};
            const rubriquesObj = isDirectQs ? { "Questions": zoneData } : zoneData;

            for (const [rName, questions] of Object.entries(rubriquesObj)) {
              tree[zName]["Questions"][rName] = [];
              (Array.isArray(questions) ? questions : []).forEach(q => {
                const key = `${zName}|${rName}|${q}`;
                const ans = answerMap[key];
                const status = ans?.status || "";

                let isGood = false;
                let count = false;
                if (status !== "") {
                  if (safety) {
                    if (status !== "Non applicable") {
                      count = true;
                      if (status === "Oui") isGood = true;
                    }
                  } else {
                    count = true;
                    if (status === "Good" || status === "Oui" || status === "1") isGood = true;
                  }
                }

                if (count) {
                  totalQ++; zoneScores[zName].total++;
                  if (isGood) { totalGood++; zoneScores[zName].good++; }
                }

                tree[zName]["Questions"][rName].push({
                  id: ans?.id || null,
                  question: q,
                  status: ans?.status || "",
                  comment: ans?.comment || "",
                  image_url: ans?.image_url || null
                });
              });
            }
          } else {
            // Sous-zones
            for (const [szName, szData] of Object.entries(zoneData)) {
              tree[zName][szName] = {};
              const rubs = Array.isArray(szData) ? { "Questions": szData } : szData;

              for (const [rName, questions] of Object.entries(rubs)) {
                tree[zName][szName][rName] = [];
                (Array.isArray(questions) ? questions : []).forEach(q => {
                  const key = `${zName}|${rName}|${q}`;
                  const ans = answerMap[key];
                  const status = ans?.status || "";

                  let isGood = false;
                  let count = false;
                  if (status !== "") {
                    if (safety) {
                      if (status !== "Non applicable") {
                        count = true;
                        if (status === "Oui") isGood = true;
                      }
                    } else {
                      count = true;
                      if (status === "Good" || status === "Oui" || status === "1") isGood = true;
                    }
                  }

                  if (count) {
                    totalQ++; zoneScores[zName].total++;
                    if (isGood) { totalGood++; zoneScores[zName].good++; }
                  }

                  tree[zName][szName][rName].push({
                    id: ans?.id || null,
                    question: q,
                    status: ans?.status || "",
                    comment: ans?.comment || "",
                    image_url: ans?.image_url || null
                  });
                });
              }
            }
          }
        }

        // --- DRAW PDF ---
        const globalScore = totalQ > 0 ? Math.round((totalGood / totalQ) * 100) : 0;
        let currentPage = 1;
        addPageDesign(currentPage);

        let y = 50;
        doc.setTextColor(...colorSlate);
        doc.setFontSize(12);
        doc.setFont(undefined, "bold");
        doc.text("Informations générales consolidées", 14, y);
        y += 8;

        doc.setFontSize(10);
        doc.setFont(undefined, "normal");
        doc.text(`Atelier : ${atelier}`, 16, y);
        y += 6;
        doc.text(`Audit : ${audit}`, 16, y);
        y += 6;
        doc.text(`Auditeur : ${username}`, 16, y);
        y += 10;

        // Score Global Box
        doc.setDrawColor(...colorEmerald);
        doc.setLineWidth(0.5);
        doc.setFillColor(240, 253, 244);
        doc.roundedRect(14, y, pageWidth - 28, 20, 3, 3, "FD");

        doc.setTextColor(...colorEmerald);
        doc.setFontSize(11);
        doc.setFont(undefined, "bold");
        doc.text("SCORE GLOBAL AUDIT", 25, y + 12);

        doc.setFontSize(16);
        doc.text(`${globalScore}%`, pageWidth - 40, y + 13);
        y += 28;

        // Tableau récapitulatif des scores par zone
        const zoneScoreRows = [];
        for (const [zn, sc] of Object.entries(zoneScores)) {
          const pct = sc.total > 0 ? Math.round((sc.good / sc.total) * 100) : 0;
          zoneScoreRows.push([zn, `${pct}%`]);
        }
        if (zoneScoreRows.length > 0) {
          doc.autoTable({
            startY: y,
            head: [["Zone", "Score"]],
            body: zoneScoreRows,
            margin: { left: 14, right: 14, top: 45, bottom: 20 },
            headStyles: { fillColor: colorSlate, textColor: 255, fontStyle: "bold", halign: "center" },
            styles: { fontSize: 9, cellPadding: 3, valign: "middle", lineWidth: 0.1, lineColor: [200, 200, 200] },
            alternateRowStyles: { fillColor: [248, 250, 252] },
            columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 40, halign: "center", fontStyle: "bold" } },
            didParseCell: (data) => {
              if (data.section === "body" && data.column.index === 1) {
                const pct = parseInt(data.cell.raw);
                if (pct >= 75) data.cell.styles.textColor = [16, 185, 129];
                else if (pct >= 50) data.cell.styles.textColor = [234, 179, 8];
                else data.cell.styles.textColor = [239, 68, 68];
              }
            },
          });
          y = doc.lastAutoTable.finalY + 15;
        }

        // Detail Loop
        for (const [zName, souszones] of Object.entries(tree)) {
          if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }

          // Zone header with score
          const zScore = zoneScores[zName];
          const zPct = zScore && zScore.total > 0 ? Math.round((zScore.good / zScore.total) * 100) : 0;

          doc.setTextColor(...colorEmerald);
          doc.setFontSize(14);
          doc.setFont(undefined, "bold");
          doc.text(`Zone : ${zName}`, 14, y);
          doc.setFontSize(11);
          doc.text(`Score : ${zPct}%`, pageWidth - 14, y, { align: "right" });
          y += 10;

          for (const [szName, rubriques] of Object.entries(souszones)) {
            if (szName !== "Questions" && szName !== "_direct") {
              if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
              doc.setTextColor(...colorSlate);
              doc.setFontSize(12);
              doc.text(`Sous-zone : ${szName}`, 16, y);
              y += 8;
            }

            for (const [rName, rAnswers] of Object.entries(rubriques)) {
              if (y > pageHeight - 40) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
              doc.setTextColor(50, 50, 50);
              doc.setFontSize(11);
              doc.text(rName, 18, y);
              y += 6;

              const rows = [];
              const imagesMap = new Map();
              rAnswers.forEach((ans, idx) => {
                rows.push([ans.question, ans.status || "", ans.comment || "", ""]);
                if (ans.id && preloadedImages[ans.id]) imagesMap.set(idx, preloadedImages[ans.id]);
              });

              doc.autoTable({
                startY: y,
                head: [["Question", "Status", "Commentaire", "Image"]],
                body: rows,
                margin: { left: 10, right: 10, top: 30, bottom: 15 },
                didDrawPage: (data) => {
                  if (doc.internal.getNumberOfPages() > currentPage) {
                    currentPage++;
                    addPageDesign(currentPage);
                  }
                },
                headStyles: { fillColor: colorEmerald, textColor: 255, fontStyle: "bold", halign: "center" },
                styles: { fontSize: 8, cellPadding: 2, valign: "middle", lineWidth: 0.1, lineColor: [200, 200, 200] },
                bodyStyles: { minCellHeight: 20 },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 20, halign: "center" }, 2: { cellWidth: 55 }, 3: { cellWidth: 25 } },
                didParseCell: (data) => {
                  if (data.section === "body" && data.column.index === 3) data.cell.text = [""];
                  if (data.section === "body" && data.column.index === 1) {
                    const val = data.cell.raw;
                    if (val === "Good" || val === "Oui") data.cell.styles.textColor = [16, 185, 129];
                    if (val === "Unsatisfactory" || val === "Non") data.cell.styles.textColor = [239, 68, 68];
                  }
                },
                didDrawCell: (data) => {
                  if (data.section === "body" && data.column.index === 3) {
                    const img = imagesMap.get(data.row.index);
                    if (img) {
                      doc.addImage(img, "JPEG", data.cell.x + 2, data.cell.y + 2, data.cell.width - 4, data.cell.height - 4);
                    }
                  }
                },
              });
              y = doc.lastAutoTable.finalY + 12;
            }
          }

          // ✅ AJOUT SECTION "AUTRES" DANS LE PDF
          const remarkKey = `${zName}|Autres|Remarques`;
          const remarkAns = answerMap[remarkKey];
          if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
            const commentText = remarkAns.comment.trim();
            const splitText = doc.splitTextToSize(commentText, pageWidth - 40);
            const boxHeight = 15 + (splitText.length * 5); // Base 15 + 5 per line

            if (y > pageHeight - (boxHeight + 10)) { doc.addPage(); currentPage++; addPageDesign(currentPage); y = 50; }
            
            doc.setFillColor(248, 250, 252);
            doc.setDrawColor(200, 200, 200);
            doc.roundedRect(14, y, pageWidth - 28, boxHeight, 2, 2, "FD");
            
            doc.setTextColor(...colorSlate);
            doc.setFontSize(10);
            doc.setFont(undefined, "bold");
            doc.text("Autres (Remarques générales) :", 18, y + 8);
            
            doc.setFont(undefined, "normal");
            doc.setFontSize(9);
            doc.text(splitText, 18, y + 15);
            y += boxHeight + 10;
          }
        }

        doc.save(`Rapport_Audit_Revey_${dateStr.replace(/\//g, "-")}.pdf`);
      } catch (err) {
        console.error(err);
        alert("Erreur PDF: " + err.message);
      } finally {
        hideLoading();
      }
    };

    await generatePDF();

  } catch (error) {
    console.error(error);
  }
});
/* ===================== PDF DOWNLOAD - SCORES COMPLETS (toutes zones) ===================== */
downloadScoreBtn?.addEventListener("click", async () => {
  const atelier = atelierSelect.value || "";
  const audit = auditSelect.value || "";
  const dateStr = new Date().toLocaleDateString("fr-FR").replace(/\//g, "-");

  if (!atelier || !audit) {
    alert("Veuillez d'abord sélectionner un atelier et un type d'audit.");
    return;
  }

  showLoading("Génération du fichier Excel...");

  try {
    const fullAuditName = `${atelier} — ${audit}`;
    const periodStartDate = getAuditPeriodStartDate(audit);

    // 1. Fetch sessions & answers
    const { data: sessions, error: sessErr } = await supabase
      .from("audit_sessions")
      .select("id, zone")
      .eq("audit", fullAuditName)
      .eq("user_id", userId)
      .gte("created_at", periodStartDate);

    const answerMap = {}; // "zone|rubrique|question" -> answer
    if (sessions && sessions.length > 0) {
      const sessionIds = sessions.map(s => s.id);
      const sessionMap = {};
      sessions.forEach(s => sessionMap[s.id] = { zone: s.zone });

      const { data: answers } = await supabase
        .from("audit_answers")
        .select("session_id, rubrique, question, status, comment")
        .in("session_id", sessionIds);

      if (answers) {
        answers.forEach(a => {
          const sess = sessionMap[a.session_id];
          if (!sess?.zone) return;
          const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;
          answerMap[key] = a;
        });
      }
    }

    // 2. Build complete list from DICT_REVEY
    const auditData = DICT_REVEY?.[atelier]?.[audit] || {};
    const excelData = [];

    const zoneScores = {};
    let totalGood = 0;
    let totalQ = 0;

    const filterBySelectedZone = isSafetyAuditSelected();
    for (const [zName, zoneData] of Object.entries(auditData)) {
      if (filterBySelectedZone && zoneSelect.value && zName !== zoneSelect.value) {
        continue;
      }

      zoneScores[zName] = { good: 0, total: 0 };

      // Helper function to process questions under a rubrique
      const processQuestions = (rName, questions) => {
        (Array.isArray(questions) ? questions : []).forEach(q => {
          const key = `${zName}|${rName}|${q}`;
          const ans = answerMap[key];

          const safety = isSafetyAuditSelected();
          let isGood = false;
          let countInTotal = false;

          const status = ans?.status || "";
          if (status !== "") {
            if (safety) {
              if (status !== "Non applicable") {
                countInTotal = true;
                if (status === "Oui") isGood = true;
              }
            } else {
              countInTotal = true;
              if (status === "Good" || status === "Oui" || status === "1") isGood = true;
            }
          }

          if (countInTotal) {
            totalQ++;
            zoneScores[zName].total++;
            if (isGood) {
              totalGood++;
              zoneScores[zName].good++;
            }
          }

          excelData.push({
            "Atelier": atelier,
            "Audit": audit,
            "Zone": zName,
            "Rubrique": rName,
            "Question": q,
            "Status": ans?.status || "",
            "Commentaire": ans?.comment || "",
            "Action Correctives": "",
            "Responsable": "",
            "Delai":""
          });
        });
      };

      if (Array.isArray(zoneData)) {
        processQuestions("Questions", zoneData);
      } else if (typeof zoneData === "object" && zoneData !== null) {
        const values = Object.values(zoneData);
        const isDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

        if (isDirectRubriques) {
          for (const [rName, questions] of Object.entries(zoneData)) {
            processQuestions(rName, questions);
          }
        } else {
          // Zone -> Sous-zone -> Rubrique -> Questions
          for (const [szName, szData] of Object.entries(zoneData)) {
            const rubriques = Array.isArray(szData) ? { "Questions": szData } : szData;
            for (const [rName, questions] of Object.entries(rubriques)) {
              processQuestions(rName, questions);
            }
          }
        }
      }

      // ✅ AJOUT REMARQUE "AUTRES" DANS L'EXCEL
      const remarkKey = `${zName}|Autres|Remarques`;
      const remarkAns = answerMap[remarkKey];
      if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
        excelData.push({
          "Atelier": atelier,
          "Audit": audit,
          "Zone": zName,
          "Rubrique": "Autres",
          "Question": "Remarques générales",
          "Status": "Information",
          "Commentaire": remarkAns.comment.trim(),
          "Actions Correctives": "",
          "Actions préventives": "",
          "Responsable": "",
          "Delai": ""
        });
      }
    }

    // 3. Generate Excel file
    const workbook = XLSX.utils.book_new();

    // Sheet 1: Score (Summary)
    const username = localStorage.getItem("username") || "Auditeur";
    const globalScore = totalQ > 0 ? Math.round((totalGood / totalQ) * 100) : 0;

    const scoreData = [
      ["Informations générales", ""],
      ["Atelier", atelier],
      ["Audit", audit],
      ["Auditeur", username],
      ["Date", new Date().toLocaleDateString("fr-FR")],
      [],
      ["SCORE GLOBAL", `${globalScore}%`],
      [],
      ["Zone", "Score"]
    ];

    for (const [zName, zScore] of Object.entries(zoneScores)) {
      const pct = zScore.total > 0 ? Math.round((zScore.good / zScore.total) * 100) : 0;
      scoreData.push([zName, `${pct}%`]);
    }

    const worksheet = XLSX.utils.aoa_to_sheet(scoreData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Score");

    // Sheet 2: New "Rapport d'Audit" (WELL ORGANIZED)
    const reportData = excelData.map(row => ({
      "Atelier": row["Atelier"],
      "Audit": row["Audit"],
      "Zone": row["Zone"],
      "Rubrique": row["Rubrique"],
      "Question": row["Question"],
      "Status": row["Status"],
      "Commentaire": row["Commentaire"],
      "Action Correctives": row["Action Correctives"],
      "Responsable": row["Responsable"],
      "Delai": row["Delai"]
    }));
    const reportSheet = XLSX.utils.json_to_sheet(reportData);
    XLSX.utils.book_append_sheet(workbook, reportSheet, "Rapport d'Audit");

    // Auto-size columns for both sheets
    [worksheet, reportSheet].forEach(ws => {
      const data = XLSX.utils.sheet_to_json(ws);
      if (data.length === 0) return;
      const headers = Object.keys(data[0]);
      const maxWidths = headers.map(h => {
        let max = h.length;
        data.forEach(row => {
          const val = row[h] ? row[h].toString() : "";
          if (val.length > max) max = val.length;
        });
        return { wch: max + 2 };
      });
      ws["!cols"] = maxWidths;
    });

    XLSX.writeFile(workbook, `Score_Audit_Revey_${dateStr}.xlsx`);

  } catch (e) {
    console.error("Erreur Export Excel:", e);
    alert("Erreur Export Excel: " + e.message);
  } finally {
    hideLoading();
  }
});
