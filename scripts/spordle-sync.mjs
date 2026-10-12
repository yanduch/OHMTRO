// Robot de synchronisation Spordle -> fichiers .ics dans le dépôt (horaires/…)
// Il fait ce qu'une personne fait sur la page Spordle : choisir l'horaire, choisir les dates
// (toute la saison), puis toucher « Ajouter » pour télécharger le calendrier .ics.
// Chaque étape laisse une capture d'écran dans spordle-debug/ pour pouvoir vérifier.
import { chromium, devices } from "playwright";
import fs from "node:fs";
import path from "node:path";

const SOURCES = JSON.parse(fs.readFileSync("scripts/spordle-sources.json", "utf8"));
const DEBUG = "spordle-debug";
fs.mkdirSync(DEBUG, { recursive: true });

// Saison de hockey : du 1er août au 31 mai suivant
function season() {
  const d = new Date(), y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return { start: `${y}-08-01`, end: `${y + 1}-05-31` };
}
const slug = s => String(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_");
const log = (...a) => console.log("•", ...a);

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(DEBUG, name + ".png"), fullPage: false }); } catch (e) {}
}
async function settle(page, ms = 1500) {
  try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch (e) {}
  await page.waitForTimeout(ms);
}
async function tryClick(locator, label, timeout = 5000) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click();
    log("clic :", label);
    return true;
  } catch (e) {
    log("introuvable :", label);
    return false;
  }
}

async function chooseSchedule(page, wanted) {
  if (!wanted) return;
  // Déjà choisi ?
  const already = page.locator("button, [role=button], [role=combobox]").filter({ hasText: new RegExp("^\\s*" + wanted + "\\s*$", "i") });
  if (await already.count()) { log("horaire déjà choisi :", wanted); return; }
  // Le menu « Horaire » (ex. « Hors-concours M15C ») : on l'ouvre puis on choisit l'horaire voulu
  const opener = page.locator("button, [role=button], [role=combobox], select").filter({ hasText: /Hors-concours|Saison r[ée]guli[èe]re|S[ée]ries|Exhibition|Horaire/i });
  if (!(await tryClick(opener, "menu Horaire"))) return;
  await page.waitForTimeout(800);
  await shot(page, "02-menu-horaire");
  await tryClick(page.getByText(wanted, { exact: true }), "« " + wanted + " »");
  await settle(page);
}

async function chooseDates(page, start, end) {
  // Le bouton des dates montre une période, ex. « 7 prochains jours (11 oct. 2026 - 17 oct. 2026) »
  const dateBtn = page.locator("button, [role=button]").filter({ hasText: /\d{4}\s*[-–]\s*.*\d{4}|prochains jours|derniers jours|Aujourd'hui/i });
  if (!(await tryClick(dateBtn, "bouton des dates", 15000))) throw new Error("Bouton des dates introuvable");
  await page.waitForTimeout(800);
  await shot(page, "03-fenetre-dates");

  // 1er choix : « Personnalisé » avec les deux dates
  let ok = false;
  if (await tryClick(page.getByText(/^Personnalis[ée]$/), "Personnalisé")) {
    await page.waitForTimeout(600);
    const inputs = page.locator("input[type=date]");
    if ((await inputs.count()) >= 2) {
      await inputs.nth(0).fill(start);
      await inputs.nth(1).fill(end);
      log("dates :", start, "→", end);
      ok = true;
    } else log("cases de date introuvables");
  }
  // 2e choix : la sélection rapide « Saison 2026-27 »
  if (!ok) {
    await tryClick(page.getByText(/^S[ée]lection rapide$/), "Sélection rapide");
    ok = await tryClick(page.locator("button, [role=button], li, label").filter({ hasText: /^\s*Saison \d{4}-\d{2}/ }).last(), "Saison complète");
  }
  await shot(page, "04-dates-choisies");
  await tryClick(page.getByRole("button", { name: /^Appliquer$/ }).or(page.getByText(/^Appliquer$/)), "Appliquer");
  await settle(page, 2500);
  await shot(page, "05-horaire-affiche");
}

async function download(page, dest) {
  const btn = page.getByRole("button", { name: /Ajouter/ }).or(page.locator("button").filter({ hasText: /^\s*Ajouter\s*$/ }));
  await btn.first().waitFor({ state: "visible", timeout: 15000 });
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 45000 }),
    btn.first().click(),
  ]);
  const tmp = path.join(DEBUG, "telechargement.ics");
  await dl.saveAs(tmp);
  let text = fs.readFileSync(tmp, "utf8");
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("Le fichier téléchargé n'est pas un calendrier");
  // DTSTAMP change à chaque téléchargement : on l'enlève pour ne pas créer de faux changements
  text = text.replace(/\r?\nDTSTAMP:[^\r\n]*/g, "");
  const n = (text.match(/BEGIN:VEVENT/g) || []).length;
  log("parties dans le fichier :", n);
  if (n === 0 && fs.existsSync(dest)) {
    const old = fs.readFileSync(dest, "utf8");
    if ((old.match(/BEGIN:VEVENT/g) || []).length > 0) { log("fichier vide : on garde l'ancien par prudence"); return n; }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  return n;
}

const { start, end } = season();
const browser = await chromium.launch();
let okCount = 0;
for (const src of SOURCES) {
  console.log("\n=== " + src.nom + " ===");
  const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "fr-CA", timezoneId: "America/Toronto", acceptDownloads: true });
  const page = await ctx.newPage();
  const tag = slug(src.nom);
  try {
    await page.goto(src.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page, 3000);
    await tryClick(page.getByRole("button", { name: /Accepter|Tout accepter|Accept/i }), "témoins (cookies)", 2000);
    await shot(page, "01-page");
    await chooseSchedule(page, src.horaire);
    await chooseDates(page, start, end);
    const n = await download(page, src.fichier);
    log("OK :", src.fichier, "(" + n + " parties)");
    okCount++;
  } catch (e) {
    console.error("ÉCHEC pour " + src.nom + " :", e.message);
    await shot(page, "99-erreur-" + tag);
  }
  for (const f of fs.readdirSync(DEBUG)) if (/^0\d-/.test(f)) fs.renameSync(path.join(DEBUG, f), path.join(DEBUG, tag + "-" + f));
  await ctx.close();
}
await browser.close();
if (!okCount) { console.error("\nAucun horaire n'a pu être récupéré. Voir les captures d'écran."); process.exit(1); }
