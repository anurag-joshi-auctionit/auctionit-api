import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { subscriptionTypes } from "../schema/subscription-types.js";

// A disposable ₹9 subscription plan for live-mode Instamojo testing (Instamojo
// discontinued its sandbox, so integration testing must use small, refundable
// real transactions — ₹9 is Instamojo's minimum). Fixed high id so it's easy to
// identify.
//
//   pnpm test-plan:add      -> create/enable the ₹9 test plan
//   pnpm test-plan:remove   -> disable it (hidden from the bidder plan list)
//
// `remove` DEACTIVATES rather than deletes so it stays FK-safe if a test
// subscription already references it.
const TEST_PLAN_ID = 99;
const TEST_PLAN_NAME = "Test Plan (₹9)";

async function main() {
  const action = process.argv[2];

  if (action === "add") {
    await db
      .insert(subscriptionTypes)
      .values({
        id: TEST_PLAN_ID,
        name: TEST_PLAN_NAME,
        amount: "9",
        gstPercent: "0",
        months: 1,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: subscriptionTypes.id,
        set: {
          name: TEST_PLAN_NAME,
          amount: "9",
          gstPercent: "0",
          months: 1,
          isActive: true,
        },
      });
    console.log(`Added/enabled test plan id=${TEST_PLAN_ID} (₹9, 1 month).`);
  } else if (action === "remove") {
    await db
      .update(subscriptionTypes)
      .set({ isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(subscriptionTypes.id, TEST_PLAN_ID));
    console.log(
      `Disabled test plan id=${TEST_PLAN_ID} (hidden from the plan list; existing test records kept).`,
    );
  } else {
    console.error("Usage: tsx test-subscription-plan.ts <add|remove>");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
