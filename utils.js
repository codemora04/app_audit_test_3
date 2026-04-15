export function clearAuditProgress() {
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key.startsWith("prog_") || 
      key.includes("_state") || 
      key === "username" ||
      key.startsWith("revey_") ||
      key.startsWith("baltimar_")
    ) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
}

export function getCurrentAuditPeriod(auditName = "") {
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const month = String(monthIndex + 1).padStart(2, '0');
  
  const nameLower = auditName.toLowerCase();
  
  if (nameLower.includes("safety")) {
    const quarter = Math.floor(monthIndex / 3) + 1;
    return `${year}`;
  }
  
  if (nameLower.includes("housekeeping")) {
    return `${year}_${month}`;
  }

  const day = now.getDate();
  const period = day <= 15 ? 'P1' : 'P2';
  return `${year}_${month}_${period}`;
}


export function getAuditPeriodStartDate(auditName = "") {
  const now = new Date();
  const nameLower = auditName.toLowerCase();
  if (nameLower.includes("safety")) {
    return new Date(now.getFullYear(), 0, 1).toISOString();
  }
  
  if (nameLower.includes("housekeeping")) {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  const periodStartDay = now.getDate() <= 15 ? 1 : 16;
  return new Date(now.getFullYear(), now.getMonth(), periodStartDay).toISOString();
}

export async function compressImage(file, maxW = 1024, quality = 0.6) {
  if (!file || !file.type.startsWith("image/")) return file;

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

  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  return new File([blob], file.name, { type: "image/jpeg" });
}


export function showLoading(text = "Chargement...") {
  let overlay = document.getElementById("global-loader");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "global-loader";
    overlay.className = "loading-overlay";
    overlay.innerHTML = `
      <div class="spinner"></div>
      <div class="loading-text">${text}</div>
    `;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector(".loading-text").textContent = text;
    overlay.classList.remove("hidden");
  }
}

export function hideLoading() {
  const overlay = document.getElementById("global-loader");
  if (overlay) overlay.classList.add("hidden");
}


export function handleSupabaseError(error, customMsg = "Une erreur est survenue") {
  console.error(customMsg, error);
  hideLoading();
  alert(`${customMsg}: ${error.message || "Erreur réseau ou serveur"}`);
}
