/**
 * Dry-run the importer against a real inventory file and print what it would do.
 *
 * Writes nothing and never prints key material. Use it to confirm column
 * mapping before committing an import.
 *
 *   npx tsx scripts/verify-inventory.ts "C:\\path\\to\\machine_ssh_inventory.xlsx"
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseInventory } from '../src/inventory/parse.js';
import { repairPemBody, INLINE_KEY_WARNING } from '../src/inventory/keys.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx scripts/verify-inventory.ts <file.xlsx|file.csv>');
  process.exit(2);
}

const result = parseInventory(readFileSync(path), basename(path));

console.log(`file            : ${basename(path)}`);
console.log(`sheet used      : ${result.sheetName ?? '(csv)'}`);
console.log(`columns detected: ${result.detectedColumns.length}`);
for (const skipped of result.skippedSheets) {
  console.log(`sheet skipped   : "${skipped.name}" — ${skipped.reason}`);
}

console.log(`\n${result.rows.length} row(s):\n`);

for (const row of result.rows) {
  const verdict = row.errors.length ? 'ERROR' : row.warnings.length ? 'WARN ' : 'OK   ';
  console.log(`[${verdict}] row ${row.rowNumber}: ${row.name || '(unnamed)'}`);
  console.log(
    `         ${row.username}@${row.host ?? row.hostname ?? '?'}:${row.sshPort}` +
      `  os=${row.os ?? 'detect'}${row.osVersion ? ` ${row.osVersion}` : ''}` +
      `  auth=${row.authMethod}  ${row.rdpProtocol}:${row.rdpPort}`,
  );
  if (row.isSelf) console.log(`         -> local host (managed without SSH)`);
  if (row.keyPathHint) console.log(`         key hint: ${row.keyPathHint}`);

  if (row.inlinePrivateKey) {
    // Report only the shape. The body is never printed.
    try {
      const repaired = repairPemBody(row.inlinePrivateKey);
      console.log(
        `         inline ${repaired.keyType} key: ` +
          `${repaired.wasWellFormed ? 'well-formed' : 'REPAIRED (was mangled)'}`,
      );
    } catch (err) {
      console.log(`         inline key: INVALID — ${(err as Error).message}`);
    }
  }

  for (const e of row.errors) console.log(`         error: ${e}`);
  for (const w of row.warnings) console.log(`         warn:  ${w}`);
}

const ok = result.rows.filter((r) => !r.errors.length).length;
console.log(`\n${ok}/${result.rows.length} importable`);

if (result.hasInlineKeys) {
  console.log(`\n!! ${INLINE_KEY_WARNING}`);
}
