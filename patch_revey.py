import re

file_path = r"c:\Users\DIJA\Desktop\Test - Copy\revey.js"

with open(file_path, "r", encoding="utf-8") as f:
    text = f.read()

# 1. Navigation Protection
text = text.replace('const zone = document.getElementById("zone")?.value;\n  if (zone) {\n    e.preventDefault();',
                    'if (currentSessionId) {\n    e.preventDefault();')
text = text.replace('const zone = document.getElementById("zone")?.value;\n    if (zone && !confirm',
                    'if (currentSessionId && !confirm')
text = text.replace('e.preventDefault();\n    }',
                    'e.preventDefault();\n    } else {\n      currentSessionId = null;\n    }')

# 2. DOM Elements
text = text.replace('const zoneSelect = document.getElementById("zone");\n\nconst rubriqueContainer',
                    'const zoneSelect = document.getElementById("zone");\n\nconst souszoneContainer = document.getElementById("souszone-container");\nconst souszoneSelect = document.getElementById("souszone");\n\nconst rubriqueContainer')

# 3. State Management
text = re.sub(r'function saveState\(\) \{.*?\n\}',
              'function saveState() {\n  const state = {\n    atelier: atelierSelect.value,\n    audit: auditSelect.value,\n    zone: zoneSelect.value,\n    souszone: souszoneSelect?.value,\n    sessionId: currentSessionId,\n  };\n  localStorage.setItem(STATE_KEY, JSON.stringify(state));\n}',
              text, flags=re.DOTALL)

restore_state_new = '''async function restoreState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return;

  let state;
  try { state = JSON.parse(raw); } catch { return; }

  const { atelier, audit, zone, souszone, sessionId } = state;
  if (!atelier) return;

  // Restore atelier
  atelierSelect.value = atelier;
  if (!atelierSelect.value) return;

  currentSessionId = sessionId || null;

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

  const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
  const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(atelier, audit, zone, null);
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
    if(souszoneSelect) souszoneSelect.appendChild(opt);
  });
  if(souszoneContainer) souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();

  if (!souszone) return;
  if(souszoneSelect) souszoneSelect.value = souszone;
  if (souszoneSelect && !souszoneSelect.value) return;

  const rubriquesObj = DICT_REVEY?.[atelier]?.[audit]?.[zone]?.[souszone];
  if (!rubriquesObj) return;

  showLoading("Chargement...");
  try {
    await getOrCreateAuditSession(atelier, audit, zone, souszone);
    const existing = await getExistingAnswers(currentSessionId);
    showRubriques(rubriquesObj, existing);
  } catch(e) { console.error(e); }
  finally { hideLoading(); }

  refreshSelectsProgress();
}'''
text = re.sub(r'async function restoreState\(\) \{.*?\n\}', restore_state_new, text, flags=re.DOTALL)

# 4. hideAllBelowAtelier
hide_all_new = '''function hideAllBelowAtelier() {
  auditContainer?.classList.add("hidden");
  zoneContainer?.classList.add("hidden");
  if(souszoneContainer) souszoneContainer.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");

  resetSelect(auditSelect);
  resetSelect(zoneSelect);
  if(souszoneSelect) resetSelect(souszoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";
  document.getElementById("progress-root")?.classList.add("hidden");
  document.getElementById("summary-section")?.classList.add("hidden");
}'''
text = re.sub(r'function hideAllBelowAtelier\(\) \{.*?\n\}', hide_all_new, text, flags=re.DOTALL)

# 5. Progress Tracking
progress_new = '''function getProgressKey(atelier, audit, zone, souszone) {
  const period = getCurrentAuditPeriod(audit);
  const id = `prog_${username}_${period}_${atelier}_${audit}_${zone}`;
  return souszone ? `${id}_${souszone}` : id;
}

function updateProgressState(atelier, audit, zone, souszone, completedObj) {
  if (!atelier || !audit || !zone) return;
  const key = getProgressKey(atelier, audit, zone, souszone);
  localStorage.setItem(key, JSON.stringify(completedObj));
}

function getProgressState(atelier, audit, zone, souszone) {
  if (!atelier || !audit || !zone) return null;
  const key = getProgressKey(atelier, audit, zone, souszone);
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : null;
}

function checkSouszonesCompletion(atelier, audit, zone, souszonesList) {
  let allComplete = true;
  for (const sz of souszonesList) {
    const state = getProgressState(atelier, audit, zone, sz);
    if (!state || state.completed < state.total || state.total === 0) {
      allComplete = false;
      break;
    }
  }
  return allComplete;
}

function refreshSelectsProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  const zoneOptions = zoneSelect.options;

  for (let i = 1; i < zoneOptions.length; i++) {
    const opt = zoneOptions[i];
    const zName = opt.value;

    const zoneData = zonesObj[zName];
    const isDirect = Array.isArray(zoneData) || (typeof zoneData === "object" && zoneData !== null && Object.values(zoneData).every((v) => Array.isArray(v)));
    const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";

    let isComplete = false;

    if (isGWP || isDirect) {
      const state = getProgressState(atelier, audit, zName, null);
      if (state && state.completed === state.total && state.total > 0) isComplete = true;
    } else {
      const souszonesList = Object.keys(zoneData || {});
      isComplete = checkSouszonesCompletion(atelier, audit, zName, souszonesList);
    }

    if (isComplete) {
      if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + zName;
    } else {
      opt.textContent = zName;
    }
  }

  const zone = zoneSelect.value;
  if (!zone) return;
  const szOptions = souszoneSelect?.options;
  if (szOptions) {
    for (let i = 1; i < szOptions.length; i++) {
      const opt = szOptions[i];
      const szName = opt.value;
      const state = getProgressState(atelier, audit, zone, szName);
      if (state && state.completed === state.total && state.total > 0) {
        if (!opt.textContent.startsWith("✅ ")) opt.textContent = "✅ " + szName;
      } else {
        opt.textContent = szName;
      }
    }
  }
}

function computeViewProgress() {
  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  const souszone = souszoneSelect?.value;
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

  updateProgressState(atelier, audit, zone, souszone || null, { total: totalRows, completed: completedRows });

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
}'''
text = re.sub(r'function getProgressKey.*?computeGlobalProgress\(\);\n\}', progress_new, text, flags=re.DOTALL)

# 6. Session DB
db_new = '''async function getOrCreateAuditSession(atelier, audit, zone, souszone) {
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
      audit: fullAuditName,
      zone: zone || null,
      souszone: souszone || null,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (errInsert) throw errInsert;
  currentSessionId = newSession.id;
  return newSession.id;
}'''
text = re.sub(r'async function getOrCreateAuditSession\([^)]*\) \{.*?\n\}', db_new, text, flags=re.DOTALL)

# 7. Event Listeners
ev_audit_new = '''auditSelect.addEventListener("change", async () => {
  hideAllBelowAtelier();
  clearState();

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  if (!atelier || !audit) return;

  const zonesObj = DICT_REVEY?.[atelier]?.[audit] || {};
  const zones = Object.keys(zonesObj);

  resetSelect(zoneSelect);
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
});'''
text = re.sub(r'auditSelect\.addEventListener\("change", async \(\) => \{.*?\n\}\);', ev_audit_new, text, flags=re.DOTALL)

ev_zone_new = '''zoneSelect.addEventListener("change", async () => {
  if (souszoneContainer) souszoneContainer.classList.add("hidden");
  rubriqueContainer?.classList.add("hidden");
  downloadBtn?.classList.add("hidden");
  downloadScoreBtn?.classList.add("hidden");
  if(souszoneSelect) resetSelect(souszoneSelect);
  if (rubriquesList) rubriquesList.innerHTML = "";

  const atelier = atelierSelect.value;
  const audit = auditSelect.value;
  const zone = zoneSelect.value;
  if (!atelier || !audit || !zone) return;

  const zoneData = DICT_REVEY?.[atelier]?.[audit]?.[zone];
  if (!zoneData) return;

  const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
  const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
  const zoneIsDirectQuestions = Array.isArray(zoneData);
  const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

  if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(atelier, audit, zone, null);
      const existing = await getExistingAnswers(currentSessionId);
      showRubriques(zoneData, existing);
    } catch(e) { handleSupabaseError(e, "Erreur"); }
    finally { hideLoading(); }
    
    refreshSelectsProgress();
    saveState();
    return;
  }

  const souszones = Object.keys(zoneData);

  if (souszoneSelect) {
    resetSelect(souszoneSelect);
    souszones.forEach((sz) => {
      const opt = document.createElement("option");
      opt.value = sz;
      opt.textContent = sz;
      souszoneSelect.appendChild(opt);
    });
  }

  if (souszoneContainer) souszoneContainer.classList.remove("hidden");
  refreshSelectsProgress();
  saveState();
});

if (souszoneSelect) {
  souszoneSelect.addEventListener("change", async () => {
    rubriqueContainer?.classList.add("hidden");
    downloadBtn?.classList.add("hidden");
    downloadScoreBtn?.classList.add("hidden");
    if (rubriquesList) rubriquesList.innerHTML = "";

    const atelier = atelierSelect.value;
    const audit = auditSelect.value;
    const zone = zoneSelect.value;
    const souszone = souszoneSelect.value;
    if (!atelier || !audit || !zone || !souszone) return;

    const rubriquesObj = DICT_REVEY?.[atelier]?.[audit]?.[zone]?.[souszone];
    if (!rubriquesObj) return;

    showLoading("Chargement...");
    try {
      await getOrCreateAuditSession(atelier, audit, zone, souszone);
      const existing = await getExistingAnswers(currentSessionId);
      showRubriques(rubriquesObj, existing);
    } catch(e) { handleSupabaseError(e, "Erreur"); }
    finally { hideLoading(); }
    saveState();
  });
}'''
text = re.sub(r'zoneSelect\.addEventListener\("change", async \(\) => \{.*?\n\}\);', ev_zone_new, text, flags=re.DOTALL)


# 8. showRubriques extracted logic
show_r_new = '''  Object.entries(rubriquesObj || {}).forEach(([rubrique, questions], index) => {
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

    (Array.isArray(questions) ? questions : []).forEach((q, qIndex) => {
      const tr = document.createElement("tr");

      const qText = q;
      const trueRubriqueTitle = rubrique;
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
      const questionText = qText;

      const ex = ansMap[`${rubriqueTitle}|${questionText}`] || ansMap[`${rubriqueTitle}|${questionText}`];
      if (ex) {
        const sel = tr.querySelector("select");
        sel.value = mapStatusVal(ex.status);
        const cmt = tr.querySelector('input[type="text"]');
        cmt.value = ex.comment || "";
      }

      async function onRowChange() {
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

        updateRowColor(tr);
        computeViewProgress();
      }

      [statusEl, commentEl].forEach((el) => {
        if (!el) return;
        el.addEventListener("change", onRowChange);
        el.addEventListener("input", onRowChange);
      });
      fileEl.addEventListener("change", onRowChange);

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

  rubriqueContainer?.classList.remove("hidden");
  downloadBtn?.classList.remove("hidden");
  downloadScoreBtn?.classList.remove("hidden");
}'''
text = re.sub(r'  Object\.entries\(rubriquesObj \|\| \{\}\)\.forEach\(\(\[rubrique, questions\], index\) => \{.*?downloadScoreBtn\?\.classList\.remove\("hidden"\);\n\}', show_r_new, text, flags=re.DOTALL)


# 9. PDF mapping fix
# sessionMap
text = text.replace('sessions.forEach(s => sessionMap[s.id] = { zone: s.zone });',
                    'sessions.forEach(s => sessionMap[s.id] = { zone: s.zone, souszone: s.souszone });')
# key lookup
text = text.replace('const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;',
                    'const szPart = sess.souszone || "_direct";\n              const key = `${sess.zone}|${szPart}|${a.rubrique || "Questions"}|${a.question}`;')


# 10. Excel Export Fixes
# answers mapping
text = text.replace('const key = `${sess.zone}|${a.rubrique || "Questions"}|${a.question}`;',
                    'const szPart = sess.souszone || "_direct";\n          const key = `${sess.zone}|${szPart}|${a.rubrique || "Questions"}|${a.question}`;')

# Excel loop
ex_loop_fix = '''    const filterBySelectedZone = audit === "Audit Safety-Chasse au anomalies";
    for (const [zName, zoneData] of Object.entries(auditData)) {
      if (filterBySelectedZone && zoneSelect.value && zName !== zoneSelect.value) {
        continue;
      }

      zoneScores[zName] = { good: 0, total: 0 };
      const isGWP = audit === "Audit GWP-Agence" || audit === "Audit GWP-Usines";
      const values = typeof zoneData === "object" && zoneData !== null ? Object.values(zoneData) : [];
      const zoneIsDirectQuestions = Array.isArray(zoneData);
      const zoneIsDirectRubriques = values.length > 0 && values.every((v) => Array.isArray(v));

      if (isGWP || zoneIsDirectQuestions || zoneIsDirectRubriques) {
        let rubriquesObj = {};
        if (Array.isArray(zoneData)) {
          rubriquesObj = { "Questions": zoneData };
        } else if (typeof zoneData === "object" && zoneData !== null) {
          const vals = Object.values(zoneData);
          const isDirectRubs = vals.length > 0 && vals.every(v => Array.isArray(v));
          if (isDirectRubs) rubriquesObj = zoneData;
          else {
            for (const [sz, szD] of Object.entries(zoneData)) {
              const subRubs = Array.isArray(szD) ? { "Questions": szD } : szD;
              for (const [r, qs] of Object.entries(subRubs)) {
                if(!rubriquesObj[r]) rubriquesObj[r] = [];
                rubriquesObj[r].push(...(qs||[]));
              }
            }
          }
        }
        for (const [rName, questions] of Object.entries(rubriquesObj)) {
          (Array.isArray(questions) ? questions : []).forEach(q => {
             const key = `${zName}|_direct|${rName}|${q}`;
             const ans = answerMap[key];
             totalQ++;
             zoneScores[zName].total++;
             const isGood = ans?.status === "Good" || ans?.status === "Oui";
             if (isGood) { totalGood++; zoneScores[zName].good++; }
             excelData.push({
               "Atelier": atelier, "Audit": audit, "Zone": zName, "Sous-zone": "-", "Rubrique": rName,
               "Question": q, "Status": ans?.status || "", "Commentaire": ans?.comment || "",
               "name1": "", "name2": ""
             });
          });
        }
      } else {
        for (const [szName, szData] of Object.entries(zoneData)) {
          const rubriquesObj = Array.isArray(szData) ? { "Questions": szData } : (typeof szData === "object" && szData !== null ? szData : {});
          for (const [rName, questions] of Object.entries(rubriquesObj)) {
            (Array.isArray(questions) ? questions : []).forEach(q => {
               const key = `${zName}|${szName}|${rName}|${q}`;
               const ans = answerMap[key];
               totalQ++;
               zoneScores[zName].total++;
               const isGood = ans?.status === "Good" || ans?.status === "Oui";
               if (isGood) { totalGood++; zoneScores[zName].good++; }
               excelData.push({
                 "Atelier": atelier, "Audit": audit, "Zone": zName, "Sous-zone": szName, "Rubrique": rName,
                 "Question": q, "Status": ans?.status || "", "Commentaire": ans?.comment || "",
                 "name1": "", "name2": ""
               });
            });
          }
        }
      }
    }'''

text = re.sub(r'    const filterBySelectedZone = audit === "Audit Safety-Chasse au anomalies";\n    for \(const \[zName, zoneData\].*?    // 3\. Generate Excel file', ex_loop_fix + '\n\n    // 3. Generate Excel file', text, flags=re.DOTALL)

with open(file_path, "w", encoding="utf-8") as f:
    f.write(text)

print("Patching complete!")
