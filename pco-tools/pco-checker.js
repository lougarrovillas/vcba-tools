// VCBA PCO Sunday Readiness Checker
// Fri 8PM  — full status summary (verses + songs)
// Sat 2PM  — final sweep (verses + songs + announcement + word)
// + completion check fires as soon as everything is green

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const GMAIL_FROM = "victorywebteam@gmail.com";
const SERVICE_TYPE_ID = "1723712";

const authHeader = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

// ── Email ────────────────────────────────────────────────
async function sendEmail(toEmail, subject, body) {
  if (!GMAIL_APP_PASSWORD) { console.warn("No Gmail password set"); return; }
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    service: "gmail",
    auth: { user: GMAIL_FROM, pass: GMAIL_APP_PASSWORD },
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

// emails = array of email strings (nulls filtered out)
async function notify(emails, subject, body) {
  await sendDiscord(body);
  for (const email of emails.filter(Boolean)) {
    await sendEmail(email, subject, body);
  }
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

// include=team so we can filter by team name
async function getPlanTeamMembers(planId) {
  const data = await pcoGet(
    `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/team_members?include=team&per_page=100`
  );
  // Build a map of team id → team name from included
  const teamMap = {};
  if (data.included) {
    for (const inc of data.included) {
      if (inc.type === "Team") {
        teamMap[inc.id] = (inc.attributes.name || "").toLowerCase();
      }
    }
  }
  // Attach team name to each member for easy lookup
  for (const member of data.data) {
    const teamId = member.relationships?.team?.data?.id;
    member._teamName = teamId ? (teamMap[teamId] || "") : "";
  }
  return data.data;
}

async function getItemAttachments(planId, itemId) {
  try {
    const data = await pcoGet(
      `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items/${itemId}/attachments?per_page=20`
    );
    return data.data;
  } catch (err) {
    console.warn("Could not get attachments for item " + itemId + ": " + err.message);
    return [];
  }
}

async function getPersonEmail(personId) {
  try {
    const data = await pcoGetPeople(`/people/${personId}/emails`);
    const primary = data.data.find(e => e.attributes.primary) || data.data[0];
    return primary ? primary.attributes.address : null;
  } catch (err) {
    console.warn("Could not get email for person " + personId + ": " + err.message);
    return null;
  }
}

// ── Team Member Lookups ──────────────────────────────────

function getSCInfo(members) {
  const sc = members.find(m =>
    (m.attributes.team_position_name || "").toLowerCase() === "coordinator"
  );
  if (!sc) return { name: "SC", personId: null };
  const personId = sc.relationships?.person?.data?.id || null;
  return { name: sc.attributes.name || "SC", personId };
}

// Proclaim = current visual tech (Technical Support team, Proclaim position)
function getProclaimInfo(members) {
  const p = members.find(m =>
    (m.attributes.team_position_name || "").toLowerCase() === "proclaim" &&
    m._teamName.includes("technical")
  );
  if (!p) return { name: null, personId: null };
  return {
    name: p.attributes.name || "Proclaim Tech",
    personId: p.relationships?.person?.data?.id || null,
  };
}

// Communications Member = comms/visual volunteer
function getCommsMemberInfo(members) {
  const c = members.find(m =>
    (m.attributes.team_position_name || "").toLowerCase() === "member" &&
    m._teamName.includes("communications")
  );
  if (!c) return { name: null, personId: null };
  return {
    name: c.attributes.name || "Comms Member",
    personId: c.relationships?.person?.data?.id || null,
  };
}

function buildHeader(plan) {
  const planDate = plan.attributes.dates || (plan.attributes.sort_date || "").split("T")[0];
  const seriesTitle = plan.attributes.series_title || "";
  const weekTitle = plan.attributes.title || "";
  const planUrl = "https://services.planningcenteronline.com/plans/" + plan.id;
  return { planDate, seriesTitle, weekTitle, planUrl };
}

function itemMatches(item, keywords) {
  const title = (item.attributes.title || "").toLowerCase();
  return keywords.some(kw => title.includes(kw));
}

// ── Item-level Checks ────────────────────────────────────

function isVerseFilled(item) {
  if (!item) return false;
  const desc = (item.attributes.description || "").toLowerCase();
  const details = (item.attributes.html_details || "").trim();
  const hasPlaceholder = desc.includes("[bible verse]");
  const hasDetails = details.length > 0;
  return !hasPlaceholder || hasDetails;
}

async function isAnnouncementFilled(planId, item) {
  if (!item) return false;
  // Check description (sometimes filled here instead of details)
  const desc = (item.attributes.description || "").trim();
  if (desc.length > 0) return true;
  // Check html_details
  const details = (item.attributes.html_details || "").trim();
  if (details.length > 0) return true;
  // Check attachments
  const attachments = await getItemAttachments(planId, item.id);
  return attachments.length > 0;
}

async function isWordFilled(planId, item) {
  if (!item) return false;
  const desc = (item.attributes.description || "");
  const details = (item.attributes.html_details || "").trim();
  const hasPlaceholder = desc.includes("[Attach Sermon Notes/Sermon Slides Here]");
  if (!hasPlaceholder || details.length > 0) return true;
  const attachments = await getItemAttachments(planId, item.id);
  return attachments.length > 0;
}

function isSongsFilled(items) {
  const songItems = items.filter(i => i.attributes.item_type === "song");
  if (songItems.length >= 4) return true;
  const songsItem = items.find(i => itemMatches(i, ["songs"]));
  if (songsItem) {
    const desc = (songsItem.attributes.description || "").toLowerCase();
    return !desc.includes("[add songs here]");
  }
  return false;
}

// ── Verse Items Config ───────────────────────────────────
const VERSE_ITEMS = [
  { keywords: ["call to worship"], label: "Call to Worship" },
  { keywords: ["tithes and offerings", "tithes & offerings"], label: "Tithes & Offerings" },
  { keywords: ["benediction"], label: "Benediction" },
];

// ── Day Checks ───────────────────────────────────────────
async function runFridayCheck(plan, items, teamMembers, emails) {
  console.log("FRIDAY CHECK - Full status summary");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let verseStatus = "";
  let versesMissing = false;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    const filled = isVerseFilled(item);
    if (!filled) versesMissing = true;
    verseStatus += (filled ? "✅" : "❌") + " " + v.label + "\n";
  }

  const songsFilled = isSongsFilled(items);
  const songCount = items.filter(i => i.attributes.item_type === "song").length;
  const allGood = !versesMissing && songsFilled;

  const subject = "📋 VCBA Friday Status — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "Friday Status Check (SC: " + scName + ")\n\n"
    + "📖 Verses:\n" + verseStatus + "\n"
    + "🎵 Songs: " + (songsFilled ? "✅" : "❌") + " " + songCount + "/4\n\n"
    + (allGood
      ? "✅ Verses and songs are good! Waiting on Saturday items (announcements + sermon)."
      : "⚠️ Some items still need attention — please follow up before Saturday.");

  await notify(emails, subject, body);
}

async function runSaturdayCheck(plan, items, teamMembers, emails) {
  console.log("SATURDAY CHECK - Final sweep");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let verseStatus = "";
  let versesMissing = false;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    const filled = isVerseFilled(item);
    if (!filled) versesMissing = true;
    verseStatus += (filled ? "✅" : "❌") + " " + v.label + "\n";
  }

  const songsFilled = isSongsFilled(items);
  const songCount = items.filter(i => i.attributes.item_type === "song").length;

  const announcementItem = items.find(i => itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  const specialItem = items.find(i => itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  // Special announcement is optional — doesn't block all-clear
  const allGood = !versesMissing && songsFilled && announcementFilled && wordFilled;

  const subject = "📢 VCBA Saturday Final Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness — FINAL SWEEP\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "📖 Verses:\n" + verseStatus + "\n"
    + "🎵 Songs: " + (songsFilled ? "✅" : "❌") + " " + songCount + "/4\n\n"
    + "📣 Announcements:\n"
    + (announcementFilled ? "✅" : "❌") + " Announcement\n"
    + (specialFilled ? "✅" : "➖") + " Special Announcement/Intro (optional)\n\n"
    + "✝️ Sermon:\n"
    + (wordFilled ? "✅" : "❌") + " Word (sermon notes/slides)\n\n"
    + (allGood
      ? "🟢 ALL CLEAR — Everything is ready! SC notify Tech Team to build the PP7 playlist."
      : "⚠️ SC (" + scName + "): Some items still need attention before Sunday.");

  await notify(emails, subject, body);
}

async function runCompletionCheck(plan, items, teamMembers, emails) {
  console.log("COMPLETION CHECK - Is everything filled?");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let versesFilled = true;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    if (!isVerseFilled(item)) { versesFilled = false; break; }
  }

  const songsFilled = isSongsFilled(items);

  const announcementItem = items.find(i => itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  const specialItem = items.find(i => itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  const allFilled = versesFilled && songsFilled && announcementFilled && wordFilled;

  console.log("Verses: " + versesFilled + ", Songs: " + songsFilled
    + ", Announcement: " + announcementFilled + ", Special: " + specialFilled + " (optional)"
    + ", Word: " + wordFilled);

  if (!allFilled) {
    console.log("Not all filled yet — skipping completion notification");
    return;
  }

  const fs = await import("fs");
  const flagFile = `/tmp/vcba_allclear_${plan.id}.flag`;
  if (fs.existsSync(flagFile)) {
    console.log("All-clear already sent for plan " + plan.id + " — skipping");
    return;
  }
  fs.writeFileSync(flagFile, new Date().toISOString());

  const subject = "🟢 VCBA OOS Ready — All Content Submitted! — " + planDate;
  const body = "🟢 ALL CLEAR — OOS READY TO BUILD\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "Everything has been submitted for this Sunday:\n"
    + "✅ Call to Worship verse\n"
    + "✅ Tithes & Offerings verse\n"
    + "✅ Benediction verse\n"
    + "✅ Songs\n"
    + "✅ Announcement\n"
    + "✅ Special Announcement/Intro\n"
    + "✅ Word (sermon notes/slides)\n\n"
    + "📋 SC (" + scName + "): OOS is ready — please notify Tech Team to start building the PP7 playlist.";

  console.log("🟢 All content filled! Sending all-clear...");
  await notify(emails, subject, body);
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  const dayOverride = process.env.DAY_OVERRIDE;
  const runCompletion = process.env.RUN_COMPLETION === "true";
  const runDay = (dayOverride !== undefined && dayOverride !== "")
    ? parseInt(dayOverride)
    : new Date().getDay();

  console.log("Running PCO checker — day " + runDay);

  const plan = await getUpcomingSundayPlan();
  console.log("Next plan: " + plan.attributes.title + " — " + plan.attributes.sort_date);

  const items = await getPlanItems(plan.id);
  const teamMembers = await getPlanTeamMembers(plan.id);

  // SC
  const { name: scName, personId: scPersonId } = getSCInfo(teamMembers);
  console.log("SC: " + scName + " (ID: " + scPersonId + ")");
  const scEmail = scPersonId ? await getPersonEmail(scPersonId) : null;
  console.log("SC Email: " + (scEmail || "NOT FOUND"));

  // Proclaim (current visual tech — Technical Support team)
  const { name: proclaimName, personId: proclaimId } = getProclaimInfo(teamMembers);
  console.log("Proclaim: " + (proclaimName || "NOT FOUND") + " (ID: " + proclaimId + ")");
  const proclaimEmail = proclaimId ? await getPersonEmail(proclaimId) : null;
  console.log("Proclaim Email: " + (proclaimEmail || "NOT FOUND"));

  // Communications Member (comms/visual volunteer)
  const { name: commsName, personId: commsId } = getCommsMemberInfo(teamMembers);
  console.log("Comms Member: " + (commsName || "NOT FOUND") + " (ID: " + commsId + ")");
  const commsEmail = commsId ? await getPersonEmail(commsId) : null;
  console.log("Comms Email: " + (commsEmail || "NOT FOUND"));

  // All recipients
  const emails = [scEmail, proclaimEmail, commsEmail];

  if (runDay === 5) await runFridayCheck(plan, items, teamMembers, emails);
  if (runDay === 6) await runSaturdayCheck(plan, items, teamMembers, emails);

  if (runCompletion || [5, 6].includes(runDay)) {
    await runCompletionCheck(plan, items, teamMembers, emails);
  }

  console.log("PCO Checker complete");
}

main().catch(err => {
  console.error("Error: " + err.message);
  process.exit(1);
});

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

async function getItemAttachments(planId, itemId) {
  try {
    const data = await pcoGet(
      `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items/${itemId}/attachments?per_page=20`
    );
    return data.data;
  } catch (err) {
    console.warn("Could not get attachments for item " + itemId + ": " + err.message);
    return [];
  }
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
  const personId = sc.relationships?.person?.data?.id || null;
  return { name: sc.attributes.name || "SC", personId };
}

function buildHeader(plan) {
  const planDate = plan.attributes.dates || (plan.attributes.sort_date || "").split("T")[0];
  const seriesTitle = plan.attributes.series_title || "";
  const weekTitle = plan.attributes.title || "";
  const planUrl = "https://services.planningcenteronline.com/plans/" + plan.id;
  return { planDate, seriesTitle, weekTitle, planUrl };
}

function itemMatches(item, keywords) {
  const title = (item.attributes.title || "").toLowerCase();
  return keywords.some(kw => title.includes(kw));
}

// ── Item-level Checks ────────────────────────────────────

// Verse: filled if [Bible Verse] placeholder is gone OR html_details has content
function isVerseFilled(item) {
  if (!item) return false;
  const desc = (item.attributes.description || "").toLowerCase();
  const details = (item.attributes.html_details || "").trim();
  const hasPlaceholder = desc.includes("[bible verse]");
  const hasDetails = details.length > 0;
  return !hasPlaceholder || hasDetails;
}

// Announcement / Special Announcement:
// filled if html_details has content OR attachment exists
async function isAnnouncementFilled(planId, item) {
  if (!item) return false;
  const details = (item.attributes.html_details || "").trim();
  if (details.length > 0) return true;
  const attachments = await getItemAttachments(planId, item.id);
  return attachments.length > 0;
}

// Word: filled if description no longer has placeholder OR attachment exists
async function isWordFilled(planId, item) {
  if (!item) return false;
  const desc = (item.attributes.description || "");
  const details = (item.attributes.html_details || "").trim();
  const hasPlaceholder = desc.includes("[Attach Sermon Notes/Sermon Slides Here]");
  if (!hasPlaceholder || details.length > 0) return true;
  const attachments = await getItemAttachments(planId, item.id);
  return attachments.length > 0;
}

// Songs: filled if 4 song-type items exist OR Songs item description updated
function isSongsFilled(items) {
  const songItems = items.filter(i => i.attributes.item_type === "song");
  if (songItems.length >= 4) return true;
  const songsItem = items.find(i => itemMatches(i, ["songs"]));
  if (songsItem) {
    const desc = (songsItem.attributes.description || "").toLowerCase();
    return !desc.includes("[add songs here]");
  }
  return false;
}

// ── Verse Items Config ───────────────────────────────────
const VERSE_ITEMS = [
  { keywords: ["call to worship"], label: "Call to Worship" },
  { keywords: ["tithes and offerings", "tithes & offerings"], label: "Tithes & Offerings" },
  { keywords: ["benediction"], label: "Benediction" },
];

// ── Day Checks ───────────────────────────────────────────
async function runWednesdayCheck(plan, items, teamMembers, scEmail) {
  console.log("WEDNESDAY CHECK - Verses due today");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let status = "";
  let anyMissing = false;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    const filled = isVerseFilled(item);
    if (!filled) anyMissing = true;
    status += (filled ? "✅" : "❌") + " " + v.label + "\n";
    console.log((filled ? "OK" : "MISSING") + " - " + v.label);
  }

  const subject = "📖 VCBA Wednesday Verse Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "📖 Wednesday Verse Check:\n" + status + "\n"
    + (anyMissing
      ? "⚠️ SC (" + scName + "): Please follow up on missing verses."
      : "✅ All verses filled!");

  await notify(scEmail, subject, body);
}

async function runThursdayCheck(plan, items, teamMembers, scEmail) {
  console.log("THURSDAY CHECK - Songs due today");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  const filled = isSongsFilled(items);
  const songCount = items.filter(i => i.attributes.item_type === "song").length;
  console.log("Songs found: " + songCount);

  const subject = "🎵 VCBA Thursday Song Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "🎵 Thursday Song Check:\n"
    + (filled ? "✅" : "❌") + " Songs: " + songCount + "/4\n\n"
    + (!filled
      ? "⚠️ SC (" + scName + "): Songs still missing. Please follow up with Worship Team."
      : "✅ All songs entered!");

  await notify(scEmail, subject, body);
}

async function runFridayCheck(plan, items, teamMembers, scEmail) {
  console.log("FRIDAY CHECK - Full status summary");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let verseStatus = "";
  let versesMissing = false;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    const filled = isVerseFilled(item);
    if (!filled) versesMissing = true;
    verseStatus += (filled ? "✅" : "❌") + " " + v.label + "\n";
  }

  const songsFilled = isSongsFilled(items);
  const songCount = items.filter(i => i.attributes.item_type === "song").length;
  const allGood = !versesMissing && songsFilled;

  const subject = "📋 VCBA Friday Status — " + planDate;
  const body = "📋 VCBA Sunday Readiness\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "Friday Status Check (SC: " + scName + ")\n\n"
    + "📖 Verses:\n" + verseStatus + "\n"
    + "🎵 Songs: " + (songsFilled ? "✅" : "❌") + " " + songCount + "/4\n\n"
    + (allGood
      ? "✅ Verses and songs are good! Waiting on Saturday items (announcements + sermon)."
      : "⚠️ Some items still need attention — please follow up before Saturday.");

  await notify(scEmail, subject, body);
}

async function runSaturdayCheck(plan, items, teamMembers, scEmail) {
  console.log("SATURDAY CHECK - Final sweep");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  // Verses
  let verseStatus = "";
  let versesMissing = false;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    const filled = isVerseFilled(item);
    if (!filled) versesMissing = true;
    verseStatus += (filled ? "✅" : "❌") + " " + v.label + "\n";
  }

  // Songs
  const songsFilled = isSongsFilled(items);
  const songCount = items.filter(i => i.attributes.item_type === "song").length;

  // Announcement
  const announcementItem = items.find(i => itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  // Special Announcement
  const specialItem = items.find(i => itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  // Word
  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  const allGood = !versesMissing && songsFilled && announcementFilled && specialFilled && wordFilled;

  const subject = "📢 VCBA Saturday Final Check — " + planDate;
  const body = "📋 VCBA Sunday Readiness — FINAL SWEEP\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "📖 Verses:\n" + verseStatus + "\n"
    + "🎵 Songs: " + (songsFilled ? "✅" : "❌") + " " + songCount + "/4\n\n"
    + "📣 Announcements:\n"
    + (announcementFilled ? "✅" : "❌") + " Announcement\n"
    + (specialFilled ? "✅" : "❌") + " Special Announcement/Intro\n\n"
    + "✝️ Sermon:\n"
    + (wordFilled ? "✅" : "❌") + " Word (sermon notes/slides)\n\n"
    + (allGood
      ? "🟢 ALL CLEAR — Everything is ready! SC notify Tech Team to build the PP7 playlist."
      : "⚠️ SC (" + scName + "): Some items still need attention before Sunday.");

  await notify(scEmail, subject, body);
}

// ── Completion Check ─────────────────────────────────────
async function runCompletionCheck(plan, items, teamMembers, scEmail) {
  console.log("COMPLETION CHECK - Is everything filled?");
  const { planDate, seriesTitle, weekTitle, planUrl } = buildHeader(plan);
  const { name: scName } = getSCInfo(teamMembers);

  let versesFilled = true;
  for (const v of VERSE_ITEMS) {
    const item = items.find(i => itemMatches(i, v.keywords));
    if (!isVerseFilled(item)) { versesFilled = false; break; }
  }

  const songsFilled = isSongsFilled(items);

  const announcementItem = items.find(i => itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  const specialItem = items.find(i => itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  const allFilled = versesFilled && songsFilled && announcementFilled && specialFilled && wordFilled;

  console.log("Verses: " + versesFilled + ", Songs: " + songsFilled
    + ", Announcement: " + announcementFilled + ", Special: " + specialFilled
    + ", Word: " + wordFilled);

  if (!allFilled) {
    console.log("Not all filled yet — skipping completion notification");
    return;
  }

  // Flag file prevents duplicate notifications within same runner session
  const fs = await import("fs");
  const flagFile = `/tmp/vcba_allclear_${plan.id}.flag`;
  if (fs.existsSync(flagFile)) {
    console.log("All-clear already sent for plan " + plan.id + " — skipping");
    return;
  }
  fs.writeFileSync(flagFile, new Date().toISOString());

  const subject = "🟢 VCBA OOS Ready — All Content Submitted! — " + planDate;
  const body = "🟢 ALL CLEAR — OOS READY TO BUILD\n"
    + (seriesTitle ? seriesTitle + " — " : "") + weekTitle + " | " + planDate + "\n"
    + planUrl + "\n\n"
    + "Everything has been submitted for this Sunday:\n"
    + "✅ Call to Worship verse\n"
    + "✅ Tithes & Offerings verse\n"
    + "✅ Benediction verse\n"
    + "✅ Songs\n"
    + "✅ Announcement\n"
    + "✅ Special Announcement/Intro\n"
    + "✅ Word (sermon notes/slides)\n\n"
    + "📋 SC (" + scName + "): OOS is ready — please notify Tech Team to start building the PP7 playlist.";

  console.log("🟢 All content filled! Sending all-clear...");
  await notify(scEmail, subject, body);
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  const dayOverride = process.env.DAY_OVERRIDE;
  const runCompletion = process.env.RUN_COMPLETION === "true";
  const runDay = (dayOverride !== undefined && dayOverride !== "")
    ? parseInt(dayOverride)
    : new Date().getDay();

  console.log("Running PCO checker — day " + runDay);

  const plan = await getUpcomingSundayPlan();
  console.log("Next plan: " + plan.attributes.title + " — " + plan.attributes.sort_date);

  const items = await getPlanItems(plan.id);
  const teamMembers = await getPlanTeamMembers(plan.id);
  const { name: scName, personId: scPersonId } = getSCInfo(teamMembers);

  console.log("Team members: " + teamMembers.length);
  console.log("SC: " + scName + " (ID: " + scPersonId + ")");

  let scEmail = null;
  if (scPersonId) {
    scEmail = await getSCEmail(scPersonId);
    console.log("SC Email: " + (scEmail || "NOT FOUND"));
  }

  if (runDay === 3) await runWednesdayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 4) await runThursdayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 5) await runFridayCheck(plan, items, teamMembers, scEmail);
  if (runDay === 6) await runSaturdayCheck(plan, items, teamMembers, scEmail);

  // Completion check runs alongside every scheduled check + when manually triggered
  if (runCompletion || [3, 4, 5, 6].includes(runDay)) {
    await runCompletionCheck(plan, items, teamMembers, scEmail);
  }

  console.log("PCO Checker complete");
}

main().catch(err => {
  console.error("Error: " + err.message);
  process.exit(1);
});
