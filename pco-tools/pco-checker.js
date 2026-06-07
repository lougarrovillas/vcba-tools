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

// Include item_notes so we can check note content for announcements
async function getPlanItems(planId) {
  const data = await pcoGet(
    `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items?include=item_notes&per_page=100`
  );
  // Build notes map: itemId → array of note content strings
  const notesMap = {};
  if (data.included) {
    for (const inc of data.included) {
      if (inc.type === "ItemNote") {
        const itemId = inc.relationships?.item?.data?.id;
        if (itemId) {
          if (!notesMap[itemId]) notesMap[itemId] = [];
          const content = (inc.attributes.content || "").trim();
          if (content) notesMap[itemId].push(content);
        }
      }
    }
  }
  for (const item of data.data) {
    item._notes = notesMap[item.id] || [];
  }
  return data.data;
}

// Include team so we can filter by team name
async function getPlanTeamMembers(planId) {
  const data = await pcoGet(
    `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/team_members?include=team&per_page=100`
  );
  const teamMap = {};
  if (data.included) {
    for (const inc of data.included) {
      if (inc.type === "Team") {
        teamMap[inc.id] = (inc.attributes.name || "").toLowerCase();
      }
    }
  }
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

// Returns ALL people in Proclaim position (supports shadowing)
function getProclaimInfoAll(members) {
  return members
    .filter(m =>
      (m.attributes.team_position_name || "").toLowerCase() === "proclaim" &&
      m._teamName.includes("technical")
    )
    .map(m => ({
      name: m.attributes.name || "Proclaim Tech",
      personId: m.relationships?.person?.data?.id || null,
    }));
}

// Returns ALL people in Comms Member position (supports shadowing)
function getCommsMemberInfoAll(members) {
  return members
    .filter(m =>
      (m.attributes.team_position_name || "").toLowerCase() === "member" &&
      m._teamName.includes("communications")
    )
    .map(m => ({
      name: m.attributes.name || "Comms Member",
      personId: m.relationships?.person?.data?.id || null,
    }));
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

// ── Helpers ──────────────────────────────────────────────

// Returns true if value has real content (not empty, not a [placeholder])
function hasRealContent(value) {
  const v = (value || "").trim();
  return v.length > 0 && !v.startsWith("[");
}

// ── Item-level Checks ────────────────────────────────────

function isVerseFilled(item) {
  if (!item) return false;
  const desc = (item.attributes.description || "").toLowerCase();
  const details = (item.attributes.html_details || "").trim();
  const hasPlaceholder = desc.includes("[bible verse]");
  return !hasPlaceholder || details.length > 0;
}

// Checks description, html_details, and attachments (not notes — those are instructions)
async function isAnnouncementFilled(planId, item) {
  if (!item) return false;
  // Check description
  if (hasRealContent(item.attributes.description)) return true;
  // Check html_details
  if (hasRealContent(item.attributes.html_details)) return true;
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

  const announcementItem = items.find(i => i.attributes.item_type !== "header" && itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  const specialItem = items.find(i => i.attributes.item_type !== "header" && itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  // Special announcement is optional — does NOT block all-clear
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

  const announcementItem = items.find(i => i.attributes.item_type !== "header" && itemMatches(i, ["announcement"]) && !itemMatches(i, ["special"]));
  const announcementFilled = await isAnnouncementFilled(plan.id, announcementItem);

  const specialItem = items.find(i => i.attributes.item_type !== "header" && itemMatches(i, ["special announcement"]));
  const specialFilled = await isAnnouncementFilled(plan.id, specialItem);

  const wordItem = items.find(i => itemMatches(i, ["word"]));
  const wordFilled = await isWordFilled(plan.id, wordItem);

  // Special announcement optional — does NOT block all-clear
  const allFilled = versesFilled && songsFilled && announcementFilled && wordFilled;

  console.log("Verses: " + versesFilled + ", Songs: " + songsFilled
    + ", Announcement: " + announcementFilled
    + ", Special (optional): " + specialFilled
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
    + (specialFilled ? "✅" : "➖") + " Special Announcement/Intro (optional)\n"
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

  // All Proclaim people
  const proclaimPeople = getProclaimInfoAll(teamMembers);
  const proclaimEmails = [];
  for (const p of proclaimPeople) {
    if (p.personId) {
      const email = await getPersonEmail(p.personId);
      console.log("Proclaim: " + p.name + " → " + (email || "NOT FOUND"));
      if (email) proclaimEmails.push(email);
    }
  }

  // All Comms Member people
  const commsPeople = getCommsMemberInfoAll(teamMembers);
  const commsEmails = [];
  for (const c of commsPeople) {
    if (c.personId) {
      const email = await getPersonEmail(c.personId);
      console.log("Comms Member: " + c.name + " → " + (email || "NOT FOUND"));
      if (email) commsEmails.push(email);
    }
  }

  // All recipients
  const emails = [scEmail, ...proclaimEmails, ...commsEmails];
  console.log("Total recipients: " + emails.filter(Boolean).length);

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
