// VCBA PCO Item Inspector
// Run this once to see exactly what fields PCO returns for Announcement and Word items
// Usage: node pco-inspector.js

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

async function inspectPlan(planId, label) {
  console.log("\n" + "=".repeat(60));
  console.log("PLAN: " + label + " (ID: " + planId + ")");
  console.log("=".repeat(60));

  // Get all items
  const data = await pcoGet(`/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items?per_page=100`);
  const items = data.data;

  // Find the items we care about
  const targetKeywords = [
    "call to worship",
    "tithes",
    "offering",
    "benediction",
    "songs",
    "announcement",
    "special announcement",
    "word",
  ];

  for (const item of items) {
    const title = (item.attributes.title || "").toLowerCase();
    const isTarget = targetKeywords.some(kw => title.includes(kw));
    if (!isTarget) continue;

    console.log("\n--- ITEM: " + item.attributes.title + " (ID: " + item.id + ") ---");
    console.log("item_type:      " + item.attributes.item_type);
    console.log("description:    " + JSON.stringify(item.attributes.description));
    console.log("details:        " + JSON.stringify(item.attributes.details));
    console.log("html_details:   " + JSON.stringify(item.attributes.html_details));
    console.log("notes:          " + JSON.stringify(item.attributes.notes));
    console.log("all attributes: " + JSON.stringify(Object.keys(item.attributes)));

    // Check item-level attachments
    try {
      const attachData = await pcoGet(
        `/service_types/${SERVICE_TYPE_ID}/plans/${planId}/items/${item.id}/attachments?per_page=20`
      );
      const attachments = attachData.data;
      console.log("attachments:    " + attachments.length);
      for (const a of attachments) {
        console.log("  - " + a.attributes.filename + " (" + a.attributes.file_size + " bytes)");
      }
    } catch (err) {
      console.log("attachments:    ERROR - " + err.message);
    }
  }
}

async function main() {
  const planIdOverride = process.env.PLAN_ID;

  if (planIdOverride) {
    await inspectPlan(planIdOverride, "Custom Plan");
  } else {
    // Default: inspect both known plans
    await inspectPlan("86465139", "April 26");
    await inspectPlan("88529314", "May 31");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Inspection complete");
}

main().catch(err => {
  console.error("Error: " + err.message);
  process.exit(1);
});
