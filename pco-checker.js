// VCBA PCO Sunday Readiness Checker
// Runs Wed (verses), Thu (songs), Fri (SC summary), Sat (files)
// Posts to Discord + sends email to SC via Gmail

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GMAIL_FROM = "victorywebteam@gmail.com";
const SERVICE_TYPE_ID = "1723712";

const authHeader = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

// ── Email via Gmail SMTP ─────────────────────────────────
async function sendEmail(toEmail, subject, body) {
  if (!GMAIL_APP_PASSWORD) { console.warn("No Gmail password set"); return; }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_FROM,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  try {
    await transporter.sendMail({
      from: `"VCBA Tech" <${GMAIL_FROM}>`,
      to: toEmail,
      subject,
      text: body,
    });
    console.log("✅ Email sent to " + toEmail);
  } catch (err) {
    console.warn("⚠️ Email failed: " + err.message);
  }
}

// ── Discord ──────────────────────────────────────────────
async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK) { console.warn("No Discord webhook set"); return; }
  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) console.warn("Discord failed: " + res.status);
  else console.log("✅ Discord message sent");
}

async function notify(toEmail, subject, body) {
  await sendDiscord(body);
  if (toEmail) await sendEmail(toEmail, subject, body);
}

// ── PCO Helpers ──────────────────────────────────────────
async function pcoGet(path) {
  const res = await fetch(`https://api.planningcenteronline.com/services/v2${path}`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`PCO GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pcoGetPeople(path) {
  const res = await fetch(`https://api.planningcenteronline.com/people/v2${path}`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`PCO People GET ${path} failed: ${res.status}`);
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

async function getSCEmail(personId) {
  try {
    const data = await pcoGetPeople(`/people/${personId}/emails`);
    const primary = data.data.find(e => e.attributes.primary) || data.data[0];
    return primary ? primary.attributes.address : null;
  } catch (err) {
    console.warn("Could not get SC email: " + err.message);
    return null;
  }
}

function getSCInfo(members) {
  const sc = members.find(m => (m.attributes.team_position_name || "").toLowerCase() === "coordinator");
  if (!sc) return { name: "SC", personId: null };
  const personId = sc.relationships && sc.relationships.person && sc.relationships.person.data
    ? sc.relationships.person.data.id : null;
  return { name: sc.attributes.name || "SC", personId };
}

function hasVersePlaceholder(item) {
  const desc = (item.attributes.description || "").toLowerCase();
  return desc.includes("[verse]") || desc.trim() === "";
}

function itemMatches(item, keywords) {
  const title = (item.attributes.title || "").toLowerCase();
  return keywords.some(kw => title.includes(kw));
}

function buildHeader(plan) {
  const planDate = plan.attributes.dates || (plan.attributes.sort_date || "").split("T")[0];
  const seriesTitle = plan.attributes.series_title || "";
  const weekTitle = plan.attributes.title || "";
  const planUrl = "https://services.planningcenteronline.com/plans/" + plan.id;
  return { planDate, seriesTitle, weekTitle, planUrl };
}

// ── Day Checks ───────────────────────────────────────────
async function runWednesdayCheck(plan, items, teamMembers, scEmail) {
  console.log("WEDNESDAY CHECK - Verses due today");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

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
    status += (missing ? "❌" : "✅") + " " + vc.label + "\n";
    console.log((missing ? "MISSING" : "OK") + " - " + vc.label);
  }

  const subject = "📖 VCBA Wednesday Verse Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " - " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "📖 Wednesday Verse Check:\n" + status + "\n"
    + (anyMissing
      ? "⚠️ SC (" + scName + "): Please follow up on missing verses."
      : "✅ All verses filled! Great job.");

  await notify(scEmail, subject, body);
}

async function runThursdayCheck(plan, items, teamMembers, scEmail) {
  console.log("THURSDAY CHECK - Songs due today");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  const songItems = items.filter(i => i.attributes.item_type === "song");
  const count = songItems.length;
  console.log("Songs found: " + count + "/4");

  const subject = "🎵 VCBA Thursday Song Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " - " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "🎵 Thursday Song Check:\n"
    + (count >= 4 ? "✅" : "❌") + " Songs: " + count + "/4\n\n"
    + (count < 4
      ? "⚠️ SC (" + scName + "): " + (4 - count) + " song(s) still missing. Please update PCO."
      : "✅ All 4 songs entered!");

  await notify(scEmail, subject, body);
}

async function runFridayCheck(plan, items, teamMembers, scEmail) {
  console.log("FRIDAY CHECK - Full status summary");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

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
    verseStatus += (missing ? "❌" : "✅") + " " + vc.label + "\n";
  }

  const songItems = items.filter(i => i.attributes.item_type === "song");
  const songCount = songItems.length;
  const allGood = !versesMissing && songCount >= 4;

  const subject = "📋 VCBA Friday Status — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " - " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "Friday Full Status (SC: " + scName + ")\n\n"
    + "📖 Verses:\n" + verseStatus + "\n"
    + "🎵 Songs: " + (songCount >= 4 ? "✅" : "❌") + " " + songCount + "/4\n\n"
    + (allGood
      ? "✅ Everything looks good! Ready for Sunday 🎉"
      : "⚠️ Some items still need attention before Sunday.");

  await notify(scEmail, subject, body);
}

async function runSaturdayCheck(plan, items, teamMembers, scEmail) {
  console.log("SATURDAY CHECK - Files due by 2PM");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);

  const attachments = await getPlanAttachments(plan.id);
  const attachmentNames = attachments.map(a => (a.attributes.filename || "").toLowerCase());
  console.log("Attachments: " + attachments.length);

  const hasAnnouncements = attachmentNames.some(n =>
    n.includes("announcement") || n.includes("graphic") || n.includes("bulletin")
  );
  const hasSermonFiles = attachmentNames.some(n =>
    n.includes("sermon") || n.includes("notes") || n.includes(".pptx") || n.includes(".pdf") || n.includes("slides")
  );

  const subject = "📢 VCBA Saturday File Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " - " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "📢 Saturday File Check (due by 2PM):\n"
    + (hasAnnouncements ? "✅" : "❌") + " Announcement graphics\n"
    + (hasSermonFiles ? "✅" : "❌") + " Sermon notes/slides\n\n"
    + (!hasAnnouncements || !hasSermonFiles
      ? "⚠️ Pastor Neil: Missing files need to be uploaded to PCO by 2PM today."
      : "✅ All files uploaded! Ready for Sunday.");

  await notify(scEmail, subject, body);
}

// ── Main ─────────────────────────────────────────────────
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
  const { name: scName, personId: scPersonId } = getSCInfo(teamMembers);

  console.log("Team members: " + teamMembers.length);
  console.log("SC: " + scName + " (ID: " + scPersonId + ")");

  // Get SC email from PCO People API
  let scEmail = null;
  if (scPersonId) {
    scEmail = await getSCEmail(scPersonId);
    console.log("SC Email: " + (scEmail || "NOT FOUND"));
  }

  if (runDay === 3) await runWednesdayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 4) await runThursdayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 5) await runFridayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 6) await runSaturdayCheck(plan, items, teamMembers, scEmail);

  console.log("PCO Checker complete");
}

main().catch(err => {
  console.error("Error: " + err.message);
  process.exit(1);
});
