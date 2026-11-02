// Copies Express Mebel data from one Firebase project to another: Firestore collections and the
// product / banner photos in Storage, rewriting photo URLs to the new bucket.
//
//   node scripts/migrate-project.mjs --from easymoda-95ccf --to expressmebel-tezkor \
//     --from-bucket <old bucket> --to-bucket <new bucket>            # dry run: counts only
//   ... --apply                                                        # copy for real
//
// Runs with the caller's Google credentials (Cloud Shell has them). Short-lived records are not
// copied: login links, admin sessions, screen pairing codes and staff invites are made again.
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const COLLECTIONS = ["meta", "products", "stockMovements", "orders", "banners", "staff", "screens"];
const BATCH = 400;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const from = opt("from");
const to = opt("to");
const fromBucket = opt("from-bucket");
const toBucket = opt("to-bucket");
const apply = args.includes("--apply");
if (!from || !to || !fromBucket || !toBucket || from === to) {
  console.error("Usage: node scripts/migrate-project.mjs --from <project> --to <project> --from-bucket <bucket> --to-bucket <bucket> [--apply]");
  process.exit(1);
}

const src = initializeApp({ projectId: from, storageBucket: fromBucket }, "from");
const dst = initializeApp({ projectId: to, storageBucket: toBucket }, "to");
const srcDb = getFirestore(src);
const dstDb = getFirestore(dst);

// Photo URLs carry the bucket name: .../v0/b/<bucket>/o/images%2F<file>?alt=media&token=...
const oldPart = `/b/${fromBucket}/o/`;
const newPart = `/b/${toBucket}/o/`;
const rewrite = (value) => {
  if (typeof value === "string") return value.replaceAll(oldPart, newPart);
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  }
  return value;
};

async function main() {
  console.log(`${apply ? "COPY" : "DRY RUN"}: ${from} (${fromBucket}) → ${to} (${toBucket})`);

  // Refuse to mix two catalogs: the target must not have products or orders yet.
  const [hasProducts, hasOrders] = await Promise.all([dstDb.collection("products").limit(1).get(), dstDb.collection("orders").limit(1).get()]);
  if (!hasProducts.empty || !hasOrders.empty) {
    console.error(`Target ${to} already has products or orders; stopping so nothing is overwritten.`);
    process.exit(2);
  }

  for (const name of COLLECTIONS) {
    const snap = await srcDb.collection(name).get();
    console.log(`  ${name}: ${snap.size}`);
    if (!apply) continue;
    for (let i = 0; i < snap.docs.length; i += BATCH) {
      const batch = dstDb.batch();
      for (const doc of snap.docs.slice(i, i + BATCH)) batch.set(dstDb.collection(name).doc(doc.id), rewrite(doc.data()));
      await batch.commit();
    }
  }

  const [files] = await getStorage(src).bucket().getFiles({ prefix: "images/" });
  console.log(`  images: ${files.length}`);
  if (apply) {
    const target = getStorage(dst).bucket();
    // A bucket-to-bucket copy keeps content type, cache headers and the download token metadata,
    // so the rewritten URLs resolve as before.
    for (const file of files) await file.copy(target.file(file.name));
  }

  console.log(apply ? "Done." : "Nothing copied. Add --apply to copy.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
