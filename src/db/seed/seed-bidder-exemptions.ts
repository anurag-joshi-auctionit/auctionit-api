// Exemption is now scoped per (clientId, bidderId); see db/schema/bidder-exemptions.ts.
// The legacy tbl_Config_BidderComp_NoNotification source has no client dimension, so
// it cannot be mapped onto the new schema. No backfill is planned — this seed is a
// no-op and bidder_exemption_logs starts empty; exemptions are entered per client
// through the admin console going forward.
async function main() {
  console.log(
    "Skipping bidder_exemption_logs seed: legacy tbl_Config_BidderComp_NoNotification " +
      "has no client dimension, and exemption is now scoped per (clientId, bidderId). " +
      "No backfill is planned; this table starts empty post-migration.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
