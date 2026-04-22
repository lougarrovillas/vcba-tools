// VCBA PCO Sunday Readiness Checker
// Runs Wed (verses), Thu (songs), Fri (SC summary), Sat (files)
// Posts to Discord + sends PCO message to SC

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const SERVICE_TYPE_ID = "1723712";

const authHeader = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK) { console.warn("No Discord webhook set"); return; }
  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) console.warn(`Discord failed: ${res.status}`);
  else console.log("Discord message sent");
}

async function pcoGet(path) {
  const res = await fetch(`https://api.planningcenteronline.com/services/v2${path}`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`PCO GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getUpcomingSundayPlan() {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans?filter=future&order=sort_date&per_page=5`);
  const plans = data.data;
  if (!plans || plans.length === 0) throw new Error("No upcoming plans found");
  return plans[0];
}

async function getPlanItems(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items?per_page=100`);
  return data.data;
}

async function getPlanTeamMembers(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/team_members?per_page=100`);
  return data.data;
}

async function getPlanAttachments(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/attachments?per_page=100`);
  return data.data;
}

function getSCName(members) {
  const sc = members.find(m => (m.attributes.team_position_name || "").toLowerCase() === "coordinator");
  return sc ? sc.attributes.name : "SC";
}

async function getSCPersonId(members) {
  const sc = members.find(m => (m.attributes.team_position_name || "").toLowerCase() === "coordinator");
  if (!sc) return null;
  const personId = sc.relationships && sc.relationships.person && sc.relationships.person.data ? sc.relationships.person.data.id : null;
  console.log("SC found: " + (sc.attributes.name || "Unknown") + " (ID: " + personId + ")");
  return personId;
}

function hasVersePlaceholder(item) {
  const desc = (item.attributes.description || "").toLowerCase();
  return desc.includes("[verse]") || desc.trim() === "";
}

function itemMatches(item, keywords) {
  const title = (item.attributes.title || "").toLowerCase();
  return keywords.some(kw => title.includes(kw));
}

async function runWednesdayCheck(plan, items, teamMembers) {
  console.log("WEDNESDAY CHECK - Verses due today");
  const planDate = (plan.attributes.sort_date || "").split("T")[0] || "this Sunday";
  const scName = getSCName(teamMembers);

  const verseChecks = [
    { keywords: ["call to worship", "c2w"], label: "Call to Worship" },
    { keywords: ["tithes", "offering"], label: "Tithes & Offering" },
    { keywords: ["benediction"], label: "Benediction" },
  ];

  let status = "";
  let anyMissing = false;
  for (const vc of verseChecks) {
    const item = items.find(i => itemMatches(i, vc.keywords));
    const missing = !item || hasVersePlaceholder(item);
    if (missing) anyMissing = true;
    status += (missing ? "X" : "OK") + " " + vc.label + "\n";
    console.log((missing ? "MISSING" : "OK") + " - " + vc.label);
  }

  const msg = "VCBA Sunday Readiness - " + planDate + "\nWednesday Verse Check:\n" + status
    + (anyMissing ? "\nSC (" + scName + "): Please follow up on missing verses." : "\nAll verses filled!");

  await sendDiscord(msg);
}

async function runThursdayCheck(plan, items, teamMembers) {
  console.log("THURSDAY CHECK - Songs due today");
  const planDate = (plan.attributes.sort_date || "").split("T")[0] || "this Sunday";
  const scName = getSCName(teamMembers);

  const songItems = items.filter(i => i.attributes.item_type === "song");
  const count = songItems.length;
  console.log("Songs found: " + count + "/4");

  const msg = "VCBA Sunday Readiness - " + planDate + "\nThursday Song Check:\n"
    + (count >= 4 ? "OK" : "MISSING") + " Songs: " + count + "/4\n"
    + (count < 4 ? "\nSC (" + scName + "): " + (4 - count) + " song(s) still missing. Please update PCO." : "\nAll 4 songs entered!");

  await sendDiscord(msg);
}

async function runFridayCheck(plan, items, teamMembers) {
  console.log("FRIDAY CHECK - Full status summary");
  const planDate = (plan.attributes.sort_date || "").split("T")[0] || "this Sunday";
  const scName = getSCName(teamMembers);

  const verseChecks = [
    { keywords: ["call to worship", "c2w"], label: "Call to Worship" },
    { keywords: ["tithes", "offering"], label: "Tithes & Offering" },
    { keywords: ["benediction"], label: "Benediction" },
  ];

  let verseStatus = "";
  let versesMissing = false;
  for (const vc of verseChecks) {
    const item = items.find(i => itemMatches(i, vc.keywords));
    const missing = !item || hasVersePlaceholder(item);
    if (missing) versesMissing = true;
    verseStatus += (missing ? "X" : "OK") + " " + vc.label + "\n";
  }

  const songItems = items.filter(i => i.attributes.item_type === "song");
  const songCount = songItems.length;
  const allGood = !versesMissing && songCount >= 4;

  const msg = "VCBA Sunday Readiness - " + planDate + "\nFriday Full Status (SC: " + scName + ")\n\n"
    + "VERSES:\n" + verseStatus + "\n"
    + "SONGS: " + (songCount >= 4 ? "OK" : "MISSING") + " " + songCount + "/4\n\n"
    + (allGood ? "All good! Ready for Sunday." : "Some items still need attention before Sunday.");

  await sendDiscord(msg);
}

async function runSaturdayCheck(plan, items, teamMembers) {
  console.log("SATURDAY CHECK - Files due by 2PM");
  const planDate = (plan.attributes.sort_date || "").split("T")[0] || "this Sunday";

  const attachments = await getPlanAttachments(plan.id);
  const attachmentNames = attachments.map(a => (a.attributes.filename || "").toLowerCase());
  console.log("Attachments found: " + attachments.length);

  const hasAnnouncements = attachmentNames.some(n =>
    n.includes("announcement") || n.includes("graphic") || n.includes("bulletin")
  );
  const hasSermonFiles = attachmentNames.some(n =>
    n.includes("sermon") || n.includes("notes") || n.includes(".pptx") || n.includes(".pdf") || n.includes("slides")
  );

  const msg = "VCBA Sunday Readiness - " + planDate + "\nSaturday File Check (due by 2PM):\n"
    + (hasAnnouncements ? "OK" : "MISSING") + " Announcement graphics\n"
    + (hasSermonFiles ? "OK" : "MISSING") + " Sermon notes/slides\n\n"
    + (!hasAnnouncements || !hasSermonFiles
      ? "Pastor Neil: Missing files need to be uploaded to PCO by 2PM today."
      : "All files uploaded! Ready for Sunday.");

  await sendDiscord(msg);
}

async function main() {
  const dayOverride = process.env.DAY_OVERRIDE;
  const runDay = (dayOverride !== undefined && dayOverride !== "") ? parseInt(dayOverride) : new Date().getDay();
  console.log("Running PCO checker - day " + runDay);

  if (![3, 4, 5, 6].includes(runDay)) {
    console.log("Not a scheduled check day. Exiting.");
    return;
  }

  const plan = await getUpcomingSundayPlan();
  console.log("Next plan: " + plan.attributes.title + " - " + plan.attributes.sort_date);

  const items = await getPlanItems(plan.id);
  const teamMembers = await getPlanTeamMembers(plan.id);
  const scPersonId = await getSCPersonId(teamMembers);

  console.log("Team members found: " + teamMembers.length);
  if (!scPersonId) console.warn("SC not found in plan");

  if (runDay === 3) await runWednesdayCheck(plan, items, teamMembers);
  if (runDay === 4) await runThursdayCheck(plan, items, teamMembers);
  if (runDay === 5) await runFridayCheck(plan, items, teamMembers);
  if (runDay === 6) await runSaturdayCheck(plan, items, teamMembers);

  console.log("PCO Checker complete");
}

main().catch(err => {
  console.error("Error: " + err.message);
  process.exit(1);
});
