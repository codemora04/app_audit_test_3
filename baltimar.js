import { supabase } from "./supabase.js";
import { getCurrentAuditPeriod, getAuditPeriodStartDate, compressImage, showLoading, hideLoading, handleSupabaseError } from "./utils.js";

/*Eviter que l'utilisateur quitte la page accidentellement.*/
window.addEventListener("beforeunload", (e) => {
  if (currentSessionId) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const btnRetour = document.querySelector(".btn-retour");
if (btnRetour) {
  btnRetour.addEventListener("click", (e) => {
    if (currentSessionId && !confirm("Un audit est en cours. Voulez-vous vraiment quitter ? Votre progression locale sera conservée mais l'audit ne sera pas finalisé.")) {
      e.preventDefault();
    } else {
        currentSessionId = null; 
    }
  });
}

/* ===================== SESSION CHECK ===================== */
const { data } = await supabase.auth.getSession();
if (!data.session) window.location.href = "login.html";
const userId = data.session.user.id;

/* Focntion pour importer les dictionnaires d'apres supabase  */
async function loadDict(name) {
  const { data, error } = await supabase
    .from("app_data")
    .select("data")
    .eq("name", name)
    .order("data", { ascending: true })
    .single();

  if (error) {
    console.error("Cannot load", name, error.message);
    alert("Erreur: impossible de charger les données depuis Supabase.");
    return null;
  }
  return data.data;
}

const DICT_BALTIMAR = await loadDict("DICT_BALTIMAR");
if (!DICT_BALTIMAR) throw new Error("DICT_BALTIMAR not loaded");

/*Recupertion des elements HTML*/
const auditSelect = document.getElementById("audit");
const zoneContainer = document.getElementById("zone-container");
const zoneSelect = document.getElementById("zone");
const souszoneContainer = document.getElementById("souszone-container");
const souszoneSelect = document.getElementById("souszone");
const rubriqueContainer = document.getElementById("rubrique-container");
const rubriquesList = document.getElementById("rubriques-list");
const downloadBtn = document.getElementById("downloadPdf");
const downloadScoreBtn = document.getElementById("downloadScoreBtn");
const username = localStorage.getItem("username") || "";
/* Variable pour stocker l'identifiant de la session en cours */
let currentSessionId = null;

/*Sauvgarder les donnees entrer par l'auditeur meme is apres refreshing*/
const STATE_KEY = "baltimar_state";
function saveState() {
  const state = {
    audit: auditSelect.value,
    zone: zoneSelect.value,
    souszone: souszoneSelect.value,
    sessionId: currentSessionId,
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}
// Supprime l'état sauvegardé du localStorage.
function clearState() {
  localStorage.removeItem(STATE_KEY);
}

/* Restaurez les sélections enregistrées sans création de nouvelle session*/
async function restoreState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return;
  let state;
  try { state = JSON.parse(raw); } catch { return; }
  const { audit, zone, souszone, sessionId } = state;
  if (!audit) return;
  // Restore audit
  auditSelect.value = audit;
  if (!auditSelect.value) return; // value no longer in list
  currentSessionId = sessionId || null;
  // Rebuild zones
  const zonesObj = DICT_BALTIMAR[audit] || {};
  const zones = Object.keys(zonesObj);
  resetSelect(zoneSelect);
  zones.forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });
  zoneContainer.classList.remove("hidden");
  refreshSelectsProgress();

  if (!zone) return;
  zoneSelect.value = zone;
  if (!zoneSelect.value) return;

  const zoneData = DICT_BALTIMAR[audit]?.[zone];
  if (!zoneData) return;

  const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
  const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(audit, zone, null);
      const existing = await getExistingAnswers(currentSessionId);
      showRubriques(zoneData, existing);
    } catch(e) { console.error(e); }
    finally { hideLoading(); }
    refreshSelectsProgress();
    return;
  }

  // Rebuild sous-zones
  const souszones = Object.keys(zoneData);
  resetSelect(souszoneSelect);
  souszones.forEach((sz) => {
    const opt = document.createElement("option");
    opt.value = sz;
    opt.textContent = sz;
    souszoneSelect.appendChild(opt);
  });
  souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();

  if (!souszone) return;
  souszoneSelect.value = souszone;
  if (!souszoneSelect.value) return;

  const rubriquesObj = DICT_BALTIMAR[audit]?.[zone]?.[souszone];
  if (!rubriquesObj) return;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(audit, zone, souszone);
    const existing = await getExistingAnswers(currentSessionId);
    showRubriques(rubriquesObj, existing);
  } catch(e) { console.error(e); }
  finally { hideLoading(); }
}

/* Fct d'affichage bien structuree */
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

function resetSelect(selectEl) {
  selectEl.innerHTML = `<option value="">--Choisir--</option>`;
}

function hideAllBelowAudit() {
  zoneContainer.classList.add("hidden");
  souszoneContainer.classList.add("hidden");
  rubriqueContainer.classList.add("hidden");
  if (downloadBtn) downloadBtn.classList.add("hidden");
  if (downloadScoreBtn) downloadScoreBtn.classList.add("hidden");

  resetSelect(zoneSelect);
  resetSelect(souszoneSelect);
  rubriquesList.innerHTML = "";
  document.getElementById("progress-root")?.classList.add("hidden");
  document.getElementById("summary-section")?.classList.add("hidden");
}

/* Vefifier si les lignes sont remplies */
function isRowComplete(tr) {
  const statusEl = tr.querySelector("select");
  const commentEl = tr.querySelector('input[type="text"]');
  const fileEl = tr.querySelector('input[type="file"]');

  const status = statusEl?.value || "";
  const comment = commentEl?.value?.trim() || "";
  const hasFile = fileEl?.files && fileEl.files.length > 0;

  if (status === "") return false;
  if (comment === "") return false;

  const imageMandatory = ["2", "3", "non"].includes(status);
  
  if (imageMandatory && !hasFile) return false;

  return true;
}
// si une ligne est complete sa couleur devient verte
function updateRowColor(tr) {
  if (isRowComplete(tr)) tr.classList.add("row-complete");
  else tr.classList.remove("row-complete");
}

/* Bar de progression */
function getProgressKey(audit, zone, souszone) {
  const period = getCurrentAuditPeriod(audit);
  const id = `prog_${username}_${period}_${audit}_${zone}`;
  return souszone ? `${id}_${souszone}` : id;
}

function updateProgressState(audit, zone, souszone, completedObj) {
  if (!audit || !zone) return;
  const key = getProgressKey(audit, zone, souszone);
  localStorage.setItem(key, JSON.stringify(completedObj));
}

function getProgressState(audit, zone, souszone) {
  if (!audit || !zone) return null;
  const key = getProgressKey(audit, zone, souszone);
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
}

function checkSouszonesCompletion(audit, zone, souszonesList) {
  let allComplete = true;
  for (const sz of souszonesList) {
    const state = getProgressState(audit, zone, sz);
    if (!state || state.completed < state.total || state.total === 0) {
      allComplete = false;
      break;
    }
  }
  return allComplete;
}

function refreshSelectsProgress() {
  const audit = auditSelect.value;
  if (!audit) return;

  // Refresh Zones
  const zoneOptions = zoneSelect.options;
  const zonesObj = DICT_BALTIMAR[audit] || {};
  for (let i = 1; i < zoneOptions.length; i++) {
    const opt = zoneOptions[i];
    const zName = opt.value;

    // Check if it's direct or has sous-zones
    const zoneData = zonesObj[zName];
    const isDirect = Array.isArray(zoneData) || (typeof zoneData === "object" && zoneData !== null && Object.values(zoneData).every((v) => Array.isArray(v)));
    const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";

    let isComplete = false;

    if (isGWP || isDirect) {
      const state = getProgressState(audit, zName, null);
      if (state && state.completed === state.total && state.total > 0) isComplete = true;
    } else {
      const souszonesList = Object.keys(zoneData || {});
      isComplete = checkSouszonesCompletion(audit, zName, souszonesList);
    }

    if (isComplete) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + zName;
    } else {
      opt.textContent = zName;
    }
  }

  // Refresh Sous-zones
  const zone = zoneSelect.value;
  if (!zone) return;
  const szOptions = souszoneSelect.options;
  for (let i = 1; i < szOptions.length; i++) {
    const opt = szOptions[i];
    const szName = opt.value;
    const state = getProgressState(audit, zone, szName);
    if (state && state.completed === state.total && state.total > 0) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + szName;
    } else {
      opt.textContent = szName;
    }
  }
}

function computeViewProgress() {
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  const souszone = souszoneSelect.value;
  if (!audit || !zone) return;

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

  // Save progress for the current view
  updateProgressState(audit, zone, souszone || null, { total: totalRows, completed: completedRows });

  // Update Summary if full
  if (totalRows > 0 && completedRows === totalRows) {
      showSummary();
  } else {
      document.getElementById("summary-section")?.classList.add("hidden");
  }

  // Update visuals in dropdowns
  refreshSelectsProgress();

  computeGlobalProgress();
}

let debounceTimerId = null;

async function computeGlobalProgress() {
  const audit = auditSelect.value;
  if (!audit) return;

  const totalQuestions = getAuditTotalQuestions(audit);
  if (totalQuestions === 0) return;

  clearTimeout(debounceTimerId);
  debounceTimerId = setTimeout(async () => {
    try {
      const periodStartDate = getAuditPeriodStartDate(audit);
      const { data: sessions } = await supabase
        .from("audit_sessions")
        .select("id")
        .eq("user_id", userId)
        .eq("audit", audit)
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

function getAuditTotalQuestions(auditName) {
  const auditData = DICT_BALTIMAR[auditName];
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
    const auditName = auditSelect.value;
    const isSafety = auditName.includes("Safety");

    rubriques.forEach(header => {
        const title = header.textContent.replace(/[▶▼0-9]/g, "").trim();
        const wrapper = header.nextElementSibling;
        const rows = wrapper.querySelectorAll("tbody tr");

        let good = 0;
        let applicable = 0; 

        rows.forEach(tr => {
            const val = tr.querySelector("select")?.value;
            if (!val) return; // Ignore empty

            if (isSafety && val === "na") return; // Ignore na if safety

            if (val === "1" || val === "oui") {
                good++;
                applicable++; 
            } else {
                applicable++; 
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

/* ===================== STATUS OPTIONS ===================== */
function getStatusOptions(auditName) {
  if (auditName === "Audit Safety-Chasse au anomalies") {
    return `
      <option value="">--</option>
      <option value="oui">Oui</option>
      <option value="non">Non</option>
      <option value="na">Non applicable</option>
    `;
  }

  return `
    <option value="">--</option>
    <option value="1">Good</option>
    <option value="2">Acceptable</option>
    <option value="3">Unsatisfactory</option>
  `;
}

/* ===================== DB HELPERS ===================== */
async function getOrCreateAuditSession(audit, zone, souszone) {
  const periodStartDate = getAuditPeriodStartDate(audit);
  
  let query = supabase
    .from("audit_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("audit", audit)
    .gte("created_at", periodStartDate);

  if (zone) query = query.eq("zone", zone);
  else query = query.is("zone", null);

  if (souszone) query = query.eq("souszone", souszone);
  else query = query.is("souszone", null);

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
      audit: audit,
      zone: zone || null,
      souszone: souszone || null,
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

  // bucket name must exist in Supabase Storage: audit-images
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const filePath = `image_url/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from("audit-images")
    .upload(filePath, file, { upsert: true });

  if (upErr) throw upErr;

  const { data } = supabase.storage.from("audit-images").getPublicUrl(filePath);
  return data.publicUrl || "";
}

async function saveAnswer({ rubriqueTitle, question, statusLabel, comment, file }) {
  if (!currentSessionId) return;

  const { data: sessionData } = await supabase
    .from("audit_sessions")
    .select("user_id, zone")
    .eq("id", currentSessionId)
    .single();

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
        user_id: sessionData?.user_id,   
        zone: sessionData?.zone,         
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

/* ===================== INIT AUDITS SELECT ===================== */
Object.keys(DICT_BALTIMAR).forEach((audit) => {
  const opt = document.createElement("option");
  opt.value = audit;
  opt.textContent = audit;
  auditSelect.appendChild(opt);
});

/* ===================== EVENTS: AUDIT / ZONE / SOUSZONE ===================== */
auditSelect.addEventListener("change", async () => {
  hideAllBelowAudit();
  clearState();

  const audit = auditSelect.value;
  if (!audit) return;

  currentSessionId = null; // Session logic moved to zones

  const zonesObj = DICT_BALTIMAR[audit] || {};
  const zones = Object.keys(zonesObj);

  resetSelect(zoneSelect);
  zones.forEach((z) => {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  });

  zoneContainer.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();
});

zoneSelect.addEventListener("change", async () => {
  souszoneContainer.classList.add("hidden");
  rubriqueContainer.classList.add("hidden");
  if (downloadBtn) downloadBtn.classList.add("hidden");
  if (downloadScoreBtn) downloadScoreBtn.classList.add("hidden");

  resetSelect(souszoneSelect);
  rubriquesList.innerHTML = "";

  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  if (!audit || !zone) return;

  const zoneData = DICT_BALTIMAR[audit]?.[zone];
  if (!zoneData) return;

  const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
  if (isGWP) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(audit, zone, null);
      const existing = await getExistingAnswers(currentSessionId);
      showRubriques(zoneData, existing);
    } catch(e) { handleSupabaseError(e, "Erreur"); }
    finally { hideLoading(); }
    
    refreshSelectsProgress();
    saveState();
    return;
  }

  // ✅ NOUVEAU : CAS "pas de sous-zone"
  const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];

  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(audit, zone, null);
      const existing = await getExistingAnswers(currentSessionId);
      showRubriques(zoneData, existing);
    } catch(e) { handleSupabaseError(e, "Erreur"); }
    finally { hideLoading(); }
    
    refreshSelectsProgress();
    saveState();
    return;
  }

  // ✅ CAS NORMAL : il y a des sous-zones
  const souszones = Object.keys(zoneData);

  resetSelect(souszoneSelect);
  souszones.forEach((sz) => {
    const opt = document.createElement("option");
    opt.value = sz;
    opt.textContent = sz;
    souszoneSelect.appendChild(opt);
  });

  souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();
});

souszoneSelect.addEventListener("change", async () => {
  rubriqueContainer.classList.add("hidden");
  if (downloadBtn) downloadBtn.classList.add("hidden");
  if (downloadScoreBtn) downloadScoreBtn.classList.add("hidden");
  rubriquesList.innerHTML = "";

  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  const souszone = souszoneSelect.value;
  if (!audit || !zone || !souszone) return;

  const rubriquesObj = DICT_BALTIMAR[audit]?.[zone]?.[souszone];
  if (!rubriquesObj) return;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(audit, zone, souszone);
    const existing = await getExistingAnswers(currentSessionId);
    showRubriques(rubriquesObj, existing);
  } catch(e) { handleSupabaseError(e, "Erreur"); }
  finally { hideLoading(); }
  saveState();
});

/* ---- Restore state on page load ---- */
await restoreState();

/* ===================== SHOW RUBRIQUES ===================== */
function showRubriques(rubriquesObj, existingAnswers = []) {
  const ansMap = {};
  existingAnswers.forEach(a => ansMap[`${a.rubrique}|${a.question}`] = a);

  function mapStatusVal(auditName, statusLabel) {
    if (auditName === "Audit Safety-Chasse au anomalies") {
      if (statusLabel === "Oui") return "oui";
      if (statusLabel === "Non") return "non";
      if (statusLabel === "Non applicable") return "na";
      return "";
    }
    if (statusLabel === "Good" || statusLabel === "Oui") return "1";
    if (statusLabel === "Acceptable") return "2";
    if (statusLabel === "Unsatisfactory" || statusLabel === "Non") return "3";
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
      const auditName = auditSelect.value;

      tr.innerHTML = `
        <td>${q}</td>

        <td>
          <select name="status_0_${qIndex}">
            ${getStatusOptions(auditName)}
          </select>
        </td>

        <td>
          <input type="text" name="comment_0_${qIndex}" placeholder="Commentaire..." />
        </td>

        <td>
          <input type="file" name="image_0_${qIndex}" accept="image/* capture="environment" " />
        </td>
      `;

      tbody.appendChild(tr);

      const statusEl = tr.querySelector("select");
      const commentEl = tr.querySelector('input[type="text"]');
      const fileEl = tr.querySelector('input[type="file"]');

      const rubriqueTitle = "Questions";
      const questionText = q;
      const ex = ansMap[`${rubriqueTitle}|${questionText}`];
      if (ex) {
        const sel = tr.querySelector("select");
        sel.value = mapStatusVal(auditName, ex.status);
        const cmt = tr.querySelector('input[type="text"]');
        cmt.value = ex.comment || "";
        if (ex.image_url) {
          fileEl.insertAdjacentHTML("beforebegin", `<a href="${ex.image_url}" target="_blank" title="Voir l'image actuelle" style="margin-right:10px; font-size:1.4rem; text-decoration:none;">🖼️</a>`);
        }
      }

      async function onRowChange() {
        const statusLabel = statusEl?.selectedOptions?.[0]?.textContent?.trim() || "";
        const comment = commentEl?.value?.trim() || "";
        const file = fileEl?.files?.[0] || null;

        await saveAnswer({
          rubriqueTitle,
          question: questionText,
          statusLabel,
          comment,
          file,
        });

        updateRowColor(tr);
        computeViewProgress();
      }

      statusEl.addEventListener("change", onRowChange);
      commentEl.addEventListener("input", onRowChange);
      fileEl.addEventListener("change", onRowChange);

      updateRowColor(tr);
    });

    tableWrapper.appendChild(table);

    header.addEventListener("click", () => {
      tableWrapper.classList.toggle("hidden");
    });

    rubriquesList.appendChild(header);
    rubriquesList.appendChild(tableWrapper);
  }

  // ✅ CAS 2 : il y a des rubriques
  else {
    Object.entries(rubriquesObj).forEach(([rubrique, questions], index) => {
      const header = document.createElement("div");
      header.className = "rubrique-header";
      header.innerHTML = `&#9654; ${rubrique}`;

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

      (questions || []).forEach((q, qIndex) => {
        const tr = document.createElement("tr");
        const auditName = auditSelect.value;

        tr.innerHTML = `
          <td>${q}</td>

          <td>
            <select name="status_${index}_${qIndex}">
              ${getStatusOptions(auditName)}
            </select>
          </td>

          <td>
            <input type="text" name="comment_${index}_${qIndex}" placeholder="Commentaire..." />
          </td>

          <td>
            <input type="file" name="image_${index}_${qIndex}" accept="image/* capture="environment" " />
          </td>
        `;

        tbody.appendChild(tr);

        const statusEl = tr.querySelector("select");
        const commentEl = tr.querySelector('input[type="text"]');
        const fileEl = tr.querySelector('input[type="file"]');

        const rubriqueTitle = rubrique;
        const questionText = q;
        const ex = ansMap[`${rubriqueTitle}|${questionText}`];
        if (ex) {
          const sel = tr.querySelector("select");
          sel.value = mapStatusVal(auditName, ex.status);
          const cmt = tr.querySelector('input[type="text"]');
          cmt.value = ex.comment || "";
          if (ex.image_url) {
            fileEl.insertAdjacentHTML("beforebegin", `<a href="${ex.image_url}" target="_blank" title="Voir l'image actuelle" style="margin-right:10px; font-size:1.4rem; text-decoration:none;">🖼️</a>`);
          }
        }

        async function onRowChange() {
          const statusLabel = statusEl?.selectedOptions?.[0]?.textContent?.trim() || "";
          const comment = commentEl?.value?.trim() || "";
          const file = fileEl?.files?.[0] || null;

          await saveAnswer({
            rubriqueTitle,
            question: questionText,
            statusLabel,
            comment,
            file,
          });

          updateRowColor(tr);
          computeViewProgress();
        }

        statusEl.addEventListener("change", onRowChange);
        commentEl.addEventListener("input", onRowChange);
        fileEl.addEventListener("change", onRowChange);

        updateRowColor(tr);
      });

      tableWrapper.appendChild(table);

      header.addEventListener("click", () => {
        tableWrapper.classList.toggle("hidden");
        header.innerHTML =
          (tableWrapper.classList.contains("hidden") ? "&#9654;" : "&#9660;") +
          " " +
          rubrique;
      });

      tableWrapper.classList.add("hidden");

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

  rubriqueContainer.classList.remove("hidden");
  if (downloadBtn) downloadBtn.classList.remove("hidden");
  if (downloadScoreBtn) downloadScoreBtn.classList.remove("hidden");
}

/* ===================== PDF: IMAGE COMPRESS ===================== */
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

    const audit = auditSelect?.value || "";
    const zone = zoneSelect?.value || "";
    const souszone = souszoneSelect?.value || "";
    const username = localStorage.getItem("username") || "Auditeur";
    const dateStr = new Date().toLocaleDateString("fr-FR");
    const timeStr = new Date().toLocaleTimeString("fr-FR");

    // Couleurs
    const colorSlate = [30, 41, 59]; 
    const colorEmerald = [16, 185, 129]; 

    const addPageDesign = (pageNum) => {
      // --- En-tête ---
      doc.setFillColor(...colorSlate);
      doc.rect(0, 0, pageWidth, 40, "F");

      try {
        doc.addImage("logo1.png", "PNG", 14, 8, 35, 15);
      } catch (e) {
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(16);
        doc.text("BALTIMAR", 14, 18);
      }
      if (audit.includes("Safety")) {
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.setFont(undefined, "bold");
        doc.text(`${audit}`, pageWidth - 14, 18, { align: "right" });
      } else {
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.setFont(undefined, "bold");
        doc.text("RAPPORT D'AUDIT", pageWidth - 14, 18, { align: "right" });
        doc.setFontSize(10);
        doc.setFont(undefined, "normal");
        doc.text(`${audit}`, pageWidth - 14, 25, { align: "right" });
      }
      doc.setFontSize(10);
      doc.setFont(undefined, "normal");
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
        const periodStartDate = getAuditPeriodStartDate(audit);
        const { data: sessions, error: sessErr } = await supabase
          .from("audit_sessions")
          .select("id, zone, souszone")
          .eq("audit", audit)
          .eq("user_id", userId)
          .gte("created_at", periodStartDate);

        const answerMap = {}; 
        const preloadedImages = {};
        const imagePromises = [];

        if (sessions && sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);
          const sessionMap = {};
          sessions.forEach(s => sessionMap[s.id] = { zone: s.zone, souszone: s.souszone });

          const { data: answers, error: ansErr } = await supabase
            .from("audit_answers")
            .select("*")
            .in("session_id", sessionIds);

          if (!ansErr && answers) {
            answers.forEach(a => {
              const sess = sessionMap[a.session_id];
              if (!sess || !sess.zone) return;
              const key = `${sess.zone}|${sess.souszone || "_direct"}|${a.rubrique || "Questions"}|${a.question}`;
              answerMap[key] = a;

              if (a.image_url && !a.image_url.includes("undefined")) {
                imagePromises.push(
                  fetch(a.image_url)
                    .then(res => res.blob())
                    .then(blob => {
                      const file = new File([blob], "image.jpg", { type: blob.type });
                      return readImageCompressed(file, 400, 0.7);
                    })
                    .then(imgData => { preloadedImages[a.id] = imgData; })
                    .catch(() => { /* mute error */ })
                );
              }
            });
          }
        }

        await Promise.all(imagePromises);

        const auditData = DICT_BALTIMAR[audit] || {};
        const tree = {};
        let totalGood = 0;
        let totalQ = 0;
        const zoneScores = {};
        const selectedZone = zoneSelect.value;
        const isSafety =audit.includes("Safety");
        
        for (const [zName, zoneData] of Object.entries(auditData)) {
          if (isSafety && zName !== selectedZone) {
            continue;
          }
          tree[zName] = {};
          zoneScores[zName] = { good: 0, total: 0 };

          const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
          const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
          const zoneIsDirectQuestions = Array.isArray(zoneData);
          const zoneIsDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

          if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
            tree[zName]["_direct"] = {};
            const rubriquesObj = Array.isArray(zoneData)
              ? { "Questions": zoneData }
              : zoneData;

            for (const [rName, questions] of Object.entries(rubriquesObj)) {
              tree[zName]["_direct"][rName] = [];
              (questions || []).forEach(q => {
                const key = `${zName}|_direct|${rName}|${q}`;
                const ans = answerMap[key] || null;
                
                const status = ans?.status || "";
                let isGood = false;
                let count = false;

                if (status !== "") {
                  if (isSafety) {
                    if (status !== "Non applicable") {
                      count = true;
                      if (status === "Oui") isGood = true;
                    }
                  } else {
                    count = true;
                    if (status === "Good" || status === "Oui") isGood = true;
                  }
                }

                if (count) {
                  totalQ++;
                  zoneScores[zName].total++;
                  if (isGood) { totalGood++; zoneScores[zName].good++; }
                }

                tree[zName]["_direct"][rName].push({
                  id: ans?.id || null,
                  question: q,
                  status: ans?.status || "",
                  comment: ans?.comment || "",
                  image_url: ans?.image_url || "",
                });
              });
            }
          } else {
            for (const [szName, szData] of Object.entries(zoneData)) {
              tree[zName][szName] = {};
              const rubriquesObj = Array.isArray(szData)
                ? { "Questions": szData }
                : (typeof szData === "object" && szData !== null ? szData : {});

              for (const [rName, questions] of Object.entries(rubriquesObj)) {
                tree[zName][szName][rName] = [];
                (questions || []).forEach(q => {
                  const key = `${zName}|${szName}|${rName}|${q}`;
                  const ans = answerMap[key] || null;
                  
                  const status = ans?.status || "";
                  let isGood = false;
                  let count = false;

                  if (status !== "") {
                    if (isSafety) {
                      if (status !== "Non applicable") {
                        count = true;
                        if (status === "Oui") isGood = true;
                      }
                    } else {
                      count = true;
                      if (status === "Good" || status === "Oui") isGood = true;
                    }
                  }

                  if (count) {
                    totalQ++;
                    zoneScores[zName].total++;
                    if (isGood) { totalGood++; zoneScores[zName].good++; }
                  }

                  tree[zName][szName][rName].push({
                    id: ans?.id || null,
                    question: q,
                    status: ans?.status || "",
                    comment: ans?.comment || "",
                    image_url: ans?.image_url || "",
                  });
                });
              }
            }
          }
        }

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
        doc.text(`Audit : ${audit}`, 16, y);
        y += 6;
        doc.text(`Auditeur : ${username}`, 16, y);
        y += 10;

        // Score Global Box
        doc.setDrawColor(...colorEmerald);
        doc.setLineWidth(0.5);
        doc.setFillColor(240, 253, 244);
        doc.roundedRect(14, y, pageWidth - 28, 20, 3, 3, "FD");
        if ( audit.includes("Safety")){
          doc.setTextColor(...colorEmerald);
          doc.setFontSize(11);
          doc.setFont(undefined,"bold");
          doc.text("SCORE GLOBAL",25, y + 12);
        }else{
        doc.setTextColor(...colorEmerald);
        doc.setFontSize(11);
        doc.setFont(undefined, "bold");
        doc.text("SCORE GLOBAL AUDIT", 25, y + 12);
      }
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
            columnStyles: { 0: { cellWidth: "auto" }, 1: { cellWidth: 40, halign: "center", fontStyle: "bold" } },
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

        for (const [zName, souszones] of Object.entries(tree)) {
          if (y > pageHeight - 60) { 
            doc.addPage(); 
            currentPage++; 
            addPageDesign(currentPage); 
            y = 70; 
          }

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
            if (szName !== "_direct") {
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
              
              rAnswers.forEach((ans, rIdx) => {
                rows.push([ans.question, ans.status || "", ans.comment || "", ""]);
                if (ans.image_url && preloadedImages[ans.id]) {
                  imagesMap.set(rIdx, preloadedImages[ans.id]);
                }
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
                columnStyles: { 0: { cellWidth: "auto" }, 1: { cellWidth: 20, halign: "center" }, 2: { cellWidth: 55 }, 3: { cellWidth: 25 } },
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
                    const imgData = imagesMap.get(data.row.index);
                    if (imgData) {
                      const x = data.cell.x + 2; const yImg = data.cell.y + 2;
                      const w = data.cell.width - 4; const h = data.cell.height - 4;
                      doc.addImage(imgData, "JPEG", x, yImg, w, h);
                    }
                  }
                },
              });

              y = doc.lastAutoTable.finalY + 10;
            }

            // ✅ AJOUT SECTION "AUTRES" DANS LE PDF (par sous-zone ou direct)
            const remarkKey = `${zName}|${szName}|Autres|Remarques`;
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
        }
      } catch (e) {
        console.error("PDF generation err:", e);
        alert("Erreur: " + e.message);
      } finally {
        hideLoading();
      }
      doc.save(`Rapport_Audit_Baltimar_${dateStr.replace(/\//g, "-")}.pdf`);
    };

    await generatePDF();
  } catch (e) {
    console.error("Erreur PDF:", e);
    alert("Erreur PDF: " + e.message);
  }
});
/* ===================== PDF DOWNLOAD - SCORES COMPLETS (toutes zones/sous-zones) ===================== */
downloadScoreBtn?.addEventListener("click", async () => {
  const audit = auditSelect.value || "";
  const usernameVal = localStorage.getItem("username") || "Auditeur";
  const dateStr = new Date().toLocaleDateString("fr-FR");

  if (!audit) {
    alert("Veuillez sélectionner un audit");
    return;
  }

  showLoading("Génération du fichier Excel...");

  const stats = { oui: 0, na: 0, non: 0, vide: 0 };

  try {
    const periodStartDate = getAuditPeriodStartDate(audit);

    //  1. Récupérer sessions
    const { data: sessions } = await supabase
      .from("audit_sessions")
      .select("id, zone, souszone")
      .eq("audit", audit)
      .eq("user_id", userId)
      .gte("created_at", periodStartDate);

    const answerMap = {};
    const sessionMap = {};

    sessions?.forEach(s => {
      sessionMap[s.id] = { zone: s.zone, souszone: s.souszone };
    });

    //  2. Récupérer réponses
    if (sessions?.length) {
      const sessionIds = sessions.map(s => s.id);

      const { data: answers } = await supabase
        .from("audit_answers")
        .select("*")
        .in("session_id", sessionIds);

      answers?.forEach(a => {
        const sess = sessionMap[a.session_id];
        if (!sess) return;

        const key = `${sess.zone}|${sess.souszone || "_direct"}|${a.rubrique || "Questions"}|${a.question}`;
        answerMap[key] = a;
      });
    }

    const auditData = DICT_BALTIMAR[audit] || {};

    const isSafetyAudit = audit.includes("Safety");

    function evalAnswer(ans) {
      const status = ans?.status || "";
      let isGood = false;
      let isApplicable = false;

      if (status !== "") {
        if (isSafetyAudit) {
          if (status !== "Non applicable") {
            isApplicable = true;
            if (status === "Oui") isGood = true;
          }
        } else {
          isApplicable = true;
          if (status === "Good" || status === "Oui") isGood = true;
        }
      }
      if (status === "Good" || status === "Oui") 
        stats.oui++;
      else if (status === "Non applicable") 
        stats.na++;
      else if (status !== "") 
        stats.non++;
      else 
        stats.vide++;

      return { isGood, isApplicable };
    }

    // ==== SHEET 1 : SCORES
    // =========================
    let totalGood = 0;
    let totalQ = 0;

    const scoreRows = [];

    scoreRows.push(["Entreprise", "BALTIMAR"]);
    scoreRows.push(["Auditeur", usernameVal]);
    scoreRows.push(["Date", dateStr]);
    scoreRows.push([]);

    const selectedZone = zoneSelect.value;
    const scoreAuditData = (isSafetyAudit && selectedZone)
      ? { [selectedZone]: auditData[selectedZone] }
      : auditData;

    for (const [zName, zoneData] of Object.entries(scoreAuditData)) {
      let zGood = 0;
      let zTotal = 0;

      const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
      const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
      const zoneIsDirectQuestions = Array.isArray(zoneData);
      const zoneIsDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

      if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
        const rubriquesObj = Array.isArray(zoneData)
          ? { "Questions": zoneData }
          : zoneData;
          
        for (const [rName, questions] of Object.entries(rubriquesObj)) {
          (questions || []).forEach(q => {
            const key = `${zName}|_direct|${rName}|${q}`;
            const { isGood, isApplicable } = evalAnswer(answerMap[key]);

            if (isApplicable) {
              zTotal++; totalQ++;
              if (isGood) { zGood++; totalGood++; }
            }
          });
        }

        const zScore = zTotal ? Math.round((zGood / zTotal) * 100) : 0;
        scoreRows.push([`Zone: ${zName}`, `${zScore}%`]);

      } else {
        scoreRows.push([`Zone: ${zName}`]);

        for (const [szName, szData] of Object.entries(zoneData)) {
          let szGood = 0;
          let szTotal = 0;

          const rubriquesObj = Array.isArray(szData)
            ? { "Questions": szData }
            : szData;

          for (const [rName, questions] of Object.entries(rubriquesObj)) {
            (questions || []).forEach(q => {
              const key = `${zName}|${szName}|${rName}|${q}`;
              const { isGood, isApplicable } = evalAnswer(answerMap[key]);

              if (isApplicable) {
                szTotal++; zTotal++; totalQ++;
                if (isGood) { szGood++; zGood++; totalGood++; }
              }
            });
          }

          const szScore = szTotal ? Math.round((szGood / szTotal) * 100) : 0;
          scoreRows.push(["", `Sous-zone: ${szName}`, `${szScore}%`]);
        }

        const zScore = zTotal ? Math.round((zGood / zTotal) * 100) : 0;
        scoreRows.push(["", "TOTAL ZONE", `${zScore}%`]);
      }

      scoreRows.push([]);
    }

    const globalScore = totalQ ? Math.round((totalGood / totalQ) * 100) : 0;
    scoreRows.push(["Score Global", `${globalScore}%`]);
    // SHEET 2 : RAPPORT
    // =========================
    const reportRows = [
      ["Zone", "Sous-zone", "Rubrique", "Question", "Status", "Commentaire", "Action Correctives", "Responsable", "Delai"]
    ];

    for (const [zName, zoneData] of Object.entries(auditData)) {

      const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
      const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
      const zoneIsDirectQuestions = Array.isArray(zoneData);
      const zoneIsDirectRubriques = values.length > 0 && values.every(v => Array.isArray(v));

      if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
        const rubriquesObj = Array.isArray(zoneData)
          ? { "Questions": zoneData }
          : zoneData;
          
        for (const [rName, questions] of Object.entries(rubriquesObj)) {
          (questions || []).forEach(q => {
            const key = `${zName}|_direct|${rName}|${q}`;
            const ans = answerMap[key];

            reportRows.push([
              zName,
              "",
              rName,
              q,
              ans?.status || "",
              ans?.comment || "",
              "",
              "",
              ""
            ]);
          });
        }

        // ✅ AJOUT REMARQUE "AUTRES" (DIRECT)
        const remarkKey = `${zName}|_direct|Autres|Remarques`;
        const remarkAns = answerMap[remarkKey];
        if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
          reportRows.push([zName, "", "Autres", "Remarques générales", "Information", remarkAns.comment.trim(), "", "", ""]);
        }

      } else {
        for (const [szName, szData] of Object.entries(zoneData)) {

          const rubriquesObj = Array.isArray(szData)
            ? { "Questions": szData }
            : szData;

          for (const [rName, questions] of Object.entries(rubriquesObj)) {
            (questions || []).forEach(q => {
              const key = `${zName}|${szName}|${rName}|${q}`;
              const ans = answerMap[key];

              reportRows.push([
                zName,
                szName,
                rName,
                q,
                ans?.status || "",
                ans?.comment || "",
                "",
                "",
                ""
              ]);
            });
          }

          // ✅ AJOUT REMARQUE "AUTRES" (SOUS-ZONE)
          const remarkKey = `${zName}|${szName}|Autres|Remarques`;
          const remarkAns = answerMap[remarkKey];
          if (remarkAns && remarkAns.comment && remarkAns.comment.trim() !== "") {
            reportRows.push([zName, szName, "Autres", "Remarques générales", "Information", remarkAns.comment.trim(), "", "", ""]);
          }
        }
      }
    }

    const wb = XLSX.utils.book_new();

    const ws1 = XLSX.utils.aoa_to_sheet(scoreRows);
    const ws2 = XLSX.utils.aoa_to_sheet(reportRows);

    XLSX.utils.book_append_sheet(wb, ws1, "Scores");
    XLSX.utils.book_append_sheet(wb, ws2, "Rapport");

    XLSX.writeFile(wb, `Audit_${audit}_${dateStr}.xlsx`);

  } catch (err) {
    console.error(err);
    alert("Erreur Excel: " + err.message);
  } finally {
    hideLoading();
  }
});
