import { supabase } from "./supabase.js";
import { handleSupabaseError, clearAuditProgress } from "./utils.js";

/* ===================== SESSION CHECK & SECURITY ===================== */
const { data: sessionData } = await supabase.auth.getSession();
if (!sessionData.session) window.location.href = "login.html";

const savedRole = sessionStorage.getItem("audit_user_role");
if (savedRole !== "responsable" && savedRole !== "auditeur") window.location.href = "accueil.html";

document.getElementById("operatorName").textContent =
    "Bienvenue, " + (sessionStorage.getItem("audit_username") || "Responsable");

/* ===================== DOM REFERENCES ===================== */
const companySelect     = document.getElementById("companySelect");
const atelierContainer  = document.getElementById("atelierContainer");
const atelierSelect     = document.getElementById("atelierSelect");
const auditSelect       = document.getElementById("auditSelect");
const chartContainer    = document.getElementById("chartContainer");
const summaryContainer  = document.getElementById("summaryTableContainer");
const noDataMessage     = document.getElementById("noDataMessage");
const logoutBtn         = document.getElementById("logoutBtn");
const downloadBtn       = document.getElementById("downloadBtn");
const canvas            = document.getElementById("scoreChart");
const zoneSpeechBubble  = document.getElementById("zoneSpeechBubble");
const ctx               = canvas.getContext("2d");

let scoreChart  = null;
let DICT_BALTIMAR = null;
let DICT_REVEY    = null;

/* ===================== ZONE STRUCTURES ===================== */

// Sub-zones for general safety audits (used in speech bubble on chart click)
const SAFETY_SUBZONES = {
    "Accès Piétons":        ["Voie d'accès", "Sol", "Signalétique", "Éclairage"],
    "Accès Engins":         ["Voie d'accès", "Sol", "Signalétique", "Éclairage"],
    "Stockage Extérieur":   ["Conformité", "Propreté", "Organisation"],
    "Parking":              ["Marquage", "Signalétique", "État général"],
    "Zone de Déchargement": ["Sécurité", "Organisation", "Propreté"],
    "Vestiaires":           ["Propreté", "Équipements", "Ventilation"],
    "Sanitaires":           ["Propreté", "État", "Accessibilité"],
    "Réfectoire":           ["Hygiène", "Équipements", "Propreté"],
    "Bureaux":              ["Ergonomie", "Ordre", "Sécurité"],
    "Ateliers":             ["Machines", "Propreté", "Rangement", "EPI", "Ventilation"],
    "Stockage Intérieur":   ["Organisation", "Rayonnages", "Signalétique"],
    "Circulation Intérieure": ["Marquage", "Dégagements", "Signalétique"],
    "Issues de Secours":    ["Accessibilité", "Signalétique", "Fonctionnement"],
    "Extincteurs":          ["Présence", "Accessibilité", "Contrôle"],
    "Électricité":          ["Armoires", "Câblage", "Conformité"],
};

// Numbered factory zones with their sub-areas (used in the summary table)
const FACTORY_ZONES = {
    "Zone 1":  ["Stockage 1500", "Station de lavage"],
    "Zone 2":  ["Atelier chaudronnerie", "Atelier mécanique", "Atelier électrique"],
    "Zone 3":  ["Stockage C130", "Stockage 840", "Stockage 842"],
    "Zone 4":  ["Station traitement eaux usée", "Bassin des acides gras"],
    "Zone 5":  ["Chaufferie"],
    "Zone 6":  ["Fosse de dépotage", "Stockage fuel", "Cantine", "Pompe de dépotage"],
    "Zone 7":  ["Stockage propane", "Stockage bouteilles de gaz", "Poste de contrôle"],
    "Zone 8":  ["Vestiaire", "Poste Transfo"],
    "Zone 9":  ["Electrolyseur N°2/N°3"],
    "Zone 10": ["Local mezzanine préparation Révey", "Préparation Révey (pâte à tartiner)"],
    "Zone 11": ["Conditionnement Révey (pâte à tartiner)", "Frigo stockage fruits secs"],
    "Zone 12": ["Shortening (Conditionnement graisse végétale)", "Fritys (Conditionnement graisse végétale)"],
    "Zone 13": ["Raffinage 1 (graisse végétale)"],
    "Zone 14": ["Hydrogénation (graisse végétale)"],
    "Zone 15": ["Magazine matériel dépotage", "Magazine produits chimiques", "Magazine acide citrique",
                "Local Calorifuge", "Stockage emballage", "PDR", "Local Sel", "Local Puits"],
    "Zone 16": ["Mezzanine salle bleue (stockage emballage/matière)", "Salle bleue"],
    "Zone 17": ["Mezzanine Révey (stockage emballage)", "Magazine Révey emballage", "Magazine Révey consommables"],
    "Zone 18": ["Raffinage 2 (graisse végétale)"],
    "Zone 19": ["Stockage 65", "Barkining", "Administration"],
    "Zone 20": ["Bureau magasinier", "Bureau maintenance", "Bureau agent de sécurité"],
};

/* ===================== HELPERS ===================== */

function isSafetyAudit() {
    return (auditSelect.value || "").toLowerCase().includes("safety");
}

function resetAuditSelect(placeholder = "-- Choisir un audit --") {
    auditSelect.innerHTML = `<option value="">${placeholder}</option>`;
    auditSelect.disabled = true;
}

function hideChart() {
    chartContainer.classList.add("hidden");
    noDataMessage.classList.add("hidden");
    if (summaryContainer) summaryContainer.classList.add("hidden");
    if (zoneSpeechBubble) zoneSpeechBubble.classList.add("hidden");
}

function showChart() {
    chartContainer.classList.remove("hidden");
    if (summaryContainer) summaryContainer.classList.remove("hidden");
}

/* ===================== DATA LOADING ===================== */

async function loadDict(name) {
    const { data, error } = await supabase
        .from("app_data")
        .select("data")
        .eq("name", name)
        .single();

    if (error) {
        console.error("Cannot load dict:", name, error);
        return null;
    }
    return data?.data ?? null;
}

function populateAudits(dict) {
    if (!dict) {
        resetAuditSelect("Erreur de chargement");
        return;
    }
    auditSelect.innerHTML = `<option value="">-- Choisir un audit --</option>`;
    Object.keys(dict).forEach(audit => {
        const opt = document.createElement("option");
        opt.value = audit;
        opt.textContent = audit;
        auditSelect.appendChild(opt);
    });
    auditSelect.disabled = false;
}

/* ===================== FILTER: COMPANY ===================== */

companySelect.addEventListener("change", async () => {
    const company = companySelect.value;

    atelierContainer.style.display = "none";
    atelierSelect.innerHTML = `<option value="">-- Choisir un atelier --</option>`;
    resetAuditSelect("-- Sélectionner une entreprise d'abord --");
    hideChart();

    if (!company) return;

    if (company === "BALTIMAR") {
        if (!DICT_BALTIMAR) DICT_BALTIMAR = await loadDict("DICT_BALTIMAR");
        populateAudits(DICT_BALTIMAR);

    } else if (company === "REVEY") {
        if (!DICT_REVEY) DICT_REVEY = await loadDict("DICT_REVEY");

        if (DICT_REVEY) {
            Object.keys(DICT_REVEY).forEach(atelier => {
                const opt = document.createElement("option");
                opt.value = atelier;
                opt.textContent = atelier;
                atelierSelect.appendChild(opt);
            });
            atelierContainer.style.display = "block";
            resetAuditSelect("-- Choisir un atelier d'abord --");
        } else {
            resetAuditSelect("Erreur de chargement de Revey");
        }
    }
});

/* ===================== FILTER: ATELIER (Revey only) ===================== */

atelierSelect.addEventListener("change", () => {
    const atelier = atelierSelect.value;
    resetAuditSelect();
    hideChart();
    if (!atelier || !DICT_REVEY) return;
    populateAudits(DICT_REVEY[atelier]);
});

/* ===================== FILTER: AUDIT → FETCH & RENDER ===================== */

auditSelect.addEventListener("change", async () => {
    const audit = auditSelect.value;
    hideChart();
    if (!audit) return;

    // 1. Fetch sessions for this audit
    const { data: sessions, error: sessErr } = await supabase
        .from("audit_sessions")
        .select("id, zone, created_at")
        .eq("audit", audit)
        .order("created_at", { ascending: true });

    if (sessErr || !sessions?.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    const sessionIds = sessions.map(s => s.id);

    // 2. Fetch answers for those sessions
    const { data: answers, error: ansErr } = await supabase
        .from("audit_answers")
        .select("session_id, status")
        .in("session_id", sessionIds);

    if (ansErr || !answers?.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    // 3. Build a lookup: session ID → { zone, formatted date }
    const sessionMap = {};
    const orderedLabels = [];

    sessions.forEach(s => {
        if (!s.zone || !s.created_at) return;
        const dateStr = new Date(s.created_at).toLocaleDateString("fr-FR", {
            month: "short",
            year: "numeric",
        });
        sessionMap[s.id] = { zone: s.zone, date: dateStr };
        if (!orderedLabels.includes(dateStr)) orderedLabels.push(dateStr);
    });

    // 4. Aggregate scores by date and zone
    const timelineStats = {};
    const uniqueZones = new Set();

    answers.forEach(ans => {
        const info = sessionMap[ans.session_id];
        if (!info) return;

        const { zone, date } = info;
        uniqueZones.add(zone);

        if (!timelineStats[date])        timelineStats[date] = {};
        if (!timelineStats[date][zone])  timelineStats[date][zone] = { total: 0, good: 0 };

        timelineStats[date][zone].total++;
        const isGood = ans.status === "Good" || ans.status === "Oui" || ans.status === "1";
        if (isGood) timelineStats[date][zone].good++;
    });

    const labels      = orderedLabels;
    const zonesToChart = Array.from(uniqueZones);

    if (!labels.length || !zonesToChart.length) {
        noDataMessage.classList.remove("hidden");
        return;
    }

    // 5. Build one Chart.js dataset per zone
    const datasets = zonesToChart.map((zone, index) => {
        const color = `hsl(${(index * 137.5) % 360}, 70%, 50%)`;
        const dataPoints = labels.map(date => {
            const stats = timelineStats[date]?.[zone];
            return stats ? Math.round((stats.good / stats.total) * 100) : null;
        });
        return {
            label: zone,
            data: dataPoints,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.3,
            spanGaps: true,
        };
    });

    renderChart(labels, datasets);
    renderSummaryTable(labels, timelineStats, zonesToChart);
    showChart();
});

/* ===================== RENDER: CHART ===================== */

function renderChart(labels, datasets) {
    if (scoreChart) scoreChart.destroy();

    Chart.defaults.color = "#94a3b8";

    scoreChart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
            responsive: true,
            datasets:{
                bar:{
                    barPercentage:0.4,
                    categoryPercentage: 0.5,
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    grid: { color: "rgba(255,255,255,0.1)" },
                    ticks: { callback: value => value + "%" },
                },
                x: {
                    grid: { color: "rgba(255,255,255,0.05)" },
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: "bottom",
                    labels: { color: "var(--text-main)" },
                },
                tooltip: {
                    callbacks: {
                        label: c => `${c.dataset.label}: ${c.parsed.y}%`,
                    },
                },
            },
            onClick: (e, elements, chart) => {
                if (!zoneSpeechBubble) return;

                if (!elements?.length) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                if (!isSafetyAudit()) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                const zone     = chart.data.datasets[elements[0].datasetIndex].label;
                const subzones = SAFETY_SUBZONES[zone];

                if (!subzones?.length) {
                    zoneSpeechBubble.classList.add("hidden");
                    return;
                }

                zoneSpeechBubble.innerHTML =
                    `<div class="bubble-title">${zone}</div>` +
                    `<ul class="bubble-list">` +
                    subzones.map(sz => `<li>${sz}</li>`).join("") +
                    `</ul>`;

                zoneSpeechBubble.classList.remove("hidden");
                zoneSpeechBubble.style.left = "-9999px";

                setTimeout(() => {
                    const x = e.native.pageX;
                    const y = e.native.pageY;
                    zoneSpeechBubble.style.left = `${x - zoneSpeechBubble.offsetWidth / 2}px`;
                    zoneSpeechBubble.style.top  = `${y - zoneSpeechBubble.offsetHeight - 15}px`;
                }, 0);
            },
        },
    });
}

/* ===================== RENDER: SUMMARY TABLE ===================== */

function renderSummaryTable(labels, timelineStats, zonesToChart) {
    const tableBody = document.getElementById("summaryTableBody");
    if (!tableBody) return;

    tableBody.innerHTML = "";

    if (!labels.length) {
        const emptyCell = document.createElement("td");
        emptyCell.colSpan = 2;
        emptyCell.textContent = "Aucune donnée disponible";
        const emptyRow = document.createElement("tr");
        emptyRow.appendChild(emptyCell);
        tableBody.appendChild(emptyRow);
        return;
    }

    const latestPeriod = labels[labels.length - 1];
    const showSubzones = isSafetyAudit();

    zonesToChart.forEach(zone => {
        const stats = timelineStats[latestPeriod]?.[zone];
        const score = stats?.total ? Math.round((stats.good / stats.total) * 100) : 0;

        // Main zone row
        const tr = document.createElement("tr");
        tr.className = "summary-zone-row";

        const tdZone = document.createElement("td");
        tdZone.className = "summary-zone-name";
        tdZone.textContent = zone;

        const tdScore = document.createElement("td");
        tdScore.className = "summary-zone-score";
        tdScore.textContent = `${score}%`;

        tr.appendChild(tdZone);
        tr.appendChild(tdScore);
        tableBody.appendChild(tr);

        // Sub-zone rows (safety audits only)
        if (showSubzones) {
            const subzones = FACTORY_ZONES[zone];
            subzones?.forEach(sz => {
                const subTr = document.createElement("tr");
                subTr.className = "summary-subzone-row";

                const tdSub = document.createElement("td");
                tdSub.className = "summary-subzone-name";
                tdSub.textContent = `↳ ${sz}`;

                const tdDash = document.createElement("td");
                tdDash.className = "summary-subzone-score";
                tdDash.textContent = "—";

                subTr.appendChild(tdSub);
                subTr.appendChild(tdDash);
                tableBody.appendChild(subTr);
            });
        }
    });
}

/* ===================== SPEECH BUBBLE: CLOSE ON OUTSIDE CLICK ===================== */

document.addEventListener("click", e => {
    if (e.target.id !== "scoreChart" && zoneSpeechBubble) {
        zoneSpeechBubble.classList.add("hidden");
    }
});

/* ===================== DOWNLOAD CHART ===================== */

downloadBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `score-audit-${(auditSelect.value || "chart").toLowerCase()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
});

/* ===================== LOGOUT ===================== */

logoutBtn.addEventListener("click", async () => {
    sessionStorage.clear();
    clearAuditProgress();
    await supabase.auth.signOut();
    window.location.href = "login.html";
});