// VCBA PCO Sunday Readiness Checker
// Runs Wed (verses), Thu (songs), Fri (SC summary), Sat (files)
// Sends PCO messages directly to assigned people

const PCO_APP_ID = process.env.PCO_APP_ID;
const PCO_SECRET = process.env.PCO_SECRET;
const SERVICE_TYPE_ID = "1723712";

const authHeader = "Basic " + Buffer.from(`${PCO_APP_ID}:${PCO_SECRET}`).toString("base64");

async function pcoGet(path) {
  const res = await fetch(`https://api.planningcenteronline.com/services/v2${path}`, {
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`PCO GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendPCOMessage(personId, subject, body) {
  const payload = {
    data: {
      type: "Message",
      attributes: { subject, body, to_person_id: personId }
    }
  };
  const res = await fetch(`https://api.planningcenteronline.com/services/v2/messages`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn(`⚠️ Message to person ${personId} failed: ${err}`);
  } else {
    console.log(`✅ Message sent to person ID ${personId}`);
  }
}

// Get the next upcoming Sunday plan
async function getUpcomingSundayPlan() {
  const today = new Date();
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans?filter=future&order=sort_date&per_page=5`);
  const plans = data.data;
  if (!plans || plans.length === 0) throw new Error("No upcoming plans found");
  // Return the soonest upcoming plan
  return plans[0];
}

// Get all plan items for a plan
async function getPlanItems(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items?per_page=100`);
  return data.data;
}

// Get team members assigned to a plan (for Speakers team)
async function getPlanTeamMembers(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/team_members?per_page=100`);
  return data.data;
}

// Get attachments/files for a plan
async function getPlanAttachments(planId) {
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/attachments?per_page=100`);
  return data.data;
}

// Get SC person ID - finds person with COORDINATOR position in Service Coordinators team
async function getSCPersonId(planId) {
  const members = await getPlanTeamMembers(planId);
  // Log all position names to help debug
  console.log("📋 All team positions:", members.map(m => `${m.attributes.team_position_name} (team: ${m.attributes.team_name})`).join(", "));
  const sc = members.find(m => {
    const pos = (m.attributes.team_position_name || "").toLowerCase();
    return pos === "coordinator";
  });
  return sc ? sc.attributes.person_id : null;
}

// Find person assigned to a specific role in Speakers team
function findPersonForRole(teamMembers, roleKeywords) {
  const member = teamMembers.find(m => {
    const pos = (m.attributes.team_position_name || "").toLowerCase();
    return roleKeywords.some(kw => pos === kw.toLowerCase());
  });
  });
  return member ? member.attributes.person_id : null;
}

// Check if item description still has [verse] placeholder
function hasVersePlaceholder(item) {
  const desc = item.attributes.description || "";
  return desc.includes("[verse]") || desc.includes("[ verse ]") || desc.trim() === "";
}

// Check if item title matches keywords
function itemMatches(item, keywords) {
  const title = (item.attributes.title || "").toLowerCase();
  return keywords.some(kw => title.includes(kw));
}

async function runWednesdayCheck(plan, items, teamMembers) {
  console.log("\n📅 WEDNESDAY CHECK — Verses due today");
  const verseItems = [
    { keywords: ["call to worship", "c2w"], roleKeywords: ["call to worship"], label: "Call to Worship" },
    { keywords: ["tithes", "offering"], roleKeywords: ["tithes & offering", "tithes and offering", "tithes"], label: "Tithes & Offering" },
    { keywords: ["benediction"], roleKeywords: ["word"], label: "Benediction" },
  ];

  for (const vi of verseItems) {
    const item = items.find(i => itemMatches(i, vi.keywords));
    if (!item) { console.log(`⚠️ Could not find plan item: ${vi.label}`); continue; }

    if (hasVersePlaceholder(item)) {
      console.log(`❌ ${vi.label} — verse not filled`);
      // Find assigned person dynamically
      let personId = findPersonForRole(teamMembers, vi.roleKeywords);
      // Benediction defaults to Pastor Neil (Word role)
      if (!personId && vi.label === "Benediction") {
        personId = findPersonForRole(teamMembers, ["word", "pastor", "speaker"]);
      }
      if (personId) {
        await sendPCOMessage(
          personId,
          `⚠️ VCBA: ${vi.label} Verse Needed`,
          `Hi! Just a reminder that the verse for **${vi.label}** in this Sunday's service plan still has a placeholder.\n\nPlease update it in Planning Center by end of day today (Wednesday).\n\nThank you! 🙏\n— VCBA Tech`
        );
      } else {
        console.warn(`⚠️ No person found for ${vi.label}`);
      }
    } else {
      console.log(`✅ ${vi.label} — verse filled`);
    }
  }
}

async function runThursdayCheck(plan, items, teamMembers, scPersonId) {
  console.log("\n📅 THURSDAY CHECK — Songs due today");
  // Songs are items of type "song" in PCO
  const songItems = items.filter(i => i.attributes.item_type === "song");
  console.log(`Found ${songItems.length} songs in plan`);

  if (songItems.length < 4) {
    console.log(`❌ Only ${songItems.length}/4 songs entered`);
    if (scPersonId) {
      await sendPCOMessage(
        scPersonId,
        `⚠️ VCBA: Songs Not Complete`,
        `Hi! The worship song list for this Sunday is not yet complete.\n\nCurrently: ${songItems.length}/4 songs entered in Planning Center.\n\nPlease add the remaining songs by end of day today (Thursday).\n\nThank you! 🙏\n— VCBA Tech`
      );
    }
  } else {
    console.log(`✅ All 4 songs entered`);
  }
}

async function runFridayCheck(plan, items, teamMembers, scPersonId) {
  console.log("\n📅 FRIDAY CHECK — Status summary to SC");

  // Check verses
  const verseChecks = [
    { keywords: ["call to worship", "c2w"], label: "Call to Worship" },
    { keywords: ["tithes", "offering", "t&o"], label: "Tithes & Offering" },
    { keywords: ["benediction"], label: "Benediction" },
  ];

  let verseStatus = "";
  for (const vc of verseChecks) {
    const item = items.find(i => itemMatches(i, vc.keywords));
    const filled = item && !hasVersePlaceholder(item);
    verseStatus += `${filled ? "✅" : "❌"} ${vc.label}\n`;
  }

  // Check songs
  const songItems = items.filter(i => i.attributes.item_type === "song");
  const songsStatus = `${songItems.length >= 4 ? "✅" : "❌"} Songs (${songItems.length}/4)`;

  const planDate = plan.attributes.sort_date?.split("T")[0] || "this Sunday";
  const allGood = !verseStatus.includes("❌") && songItems.length >= 4;

  const message = `📋 VCBA Weekly Status — ${planDate}\n\n`
    + `VERSES:\n${verseStatus}\n`
    + `SONGS:\n${songsStatus}\n\n`
    + (allGood
      ? "✅ Everything looks good! Great job team 🎉"
      : "⚠️ Some items still need attention. Please follow up with the assigned persons.");

  if (scPersonId) {
    await sendPCOMessage(scPersonId, `📋 VCBA Sunday Readiness — ${planDate}`, message);
  } else {
    console.warn("⚠️ SC person not found — could not send Friday summary");
  }
  console.log("Friday summary sent to SC");
}

async function runSaturdayCheck(plan, items, teamMembers) {
  console.log("\n📅 SATURDAY CHECK — Files due by 2PM");

  const attachments = await getPlanAttachments(plan.id);
  const attachmentNames = attachments.map(a => (a.attributes.filename || "").toLowerCase());

  // Check for announcement graphics
  const hasAnnouncements = attachmentNames.some(n =>
    n.includes("announcement") || n.includes("graphic") || n.includes("bulletin")
  );

  // Check for sermon notes/slides
  const hasSermonFiles = attachmentNames.some(n =>
    n.includes("sermon") || n.includes("notes") || n.includes(".pptx") || n.includes(".pdf") || n.includes("slides")
  );

  // Find Pastor Neil's person ID
  const pastorPersonId = findPersonForRole(teamMembers, ["word", "pastor", "speaker"]);

  let missing = [];
  if (!hasAnnouncements) missing.push("Announcement graphics");
  if (!hasSermonFiles) missing.push("Sermon notes/slides");

  if (missing.length > 0) {
    console.log(`❌ Missing files: ${missing.join(", ")}`);
    if (pastorPersonId) {
      await sendPCOMessage(
        pastorPersonId,
        `⚠️ VCBA: Files Needed by 2PM Today`,
        `Hi Pastor Neil! The following files are still missing from this Sunday's plan:\n\n`
          + missing.map(m => `• ${m}`).join("\n")
          + `\n\nPlease upload them to Planning Center by 2:00 PM today.\n\nThank you! 🙏\n— VCBA Tech`
      );
    }
  } else {
    console.log("✅ All files uploaded");
  }
}

async function main() {
  const day = new Date().getDay(); // 0=Sun, 1=Mon, ..., 3=Wed, 4=Thu, 5=Fri, 6=Sat
  // For testing, you can override: const day = parseInt(process.env.DAY_OVERRIDE || new Date().getDay());
  const dayOverride = process.env.DAY_OVERRIDE;
  const runDay = dayOverride !== undefined ? parseInt(dayOverride) : day;

  console.log(`🕐 Running PCO checker — day ${runDay}`);

  if (![3, 4, 5, 6].includes(runDay)) {
    console.log("Not a scheduled check day. Exiting.");
    return;
  }

  const plan = await getUpcomingSundayPlan();
  console.log(`📋 Next plan: ${plan.attributes.title} — ${plan.attributes.sort_date}`);

  const items = await getPlanItems(plan.id);
  const teamMembers = await getPlanTeamMembers(plan.id);
  const scPersonId = await getSCPersonId(plan.id);

  console.log(`👥 Team members found: ${teamMembers.length}`);
  console.log(`🎵 SC Person ID: ${scPersonId || "NOT FOUND"}`);

  if (runDay === 3) await runWednesdayCheck(plan, items, teamMembers);
  if (runDay === 4) await runThursdayCheck(plan, items, teamMembers, scPersonId);
  if (runDay === 5) await runFridayCheck(plan, items, teamMembers, scPersonId);
  if (runDay === 6) await runSaturdayCheck(plan, items, teamMembers);

  console.log("\n✅ PCO Checker complete");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
