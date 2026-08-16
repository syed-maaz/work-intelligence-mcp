import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

const ajv = new Ajv2020({ validateFormats: false });
const root = new URL('../', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('wi.config.schema.json', root), 'utf-8'));
const config = JSON.parse(readFileSync(new URL('wi.config.json', root), 'utf-8'));
const validate = ajv.compile(schema);
if (!validate(config)) {
  console.error('config:validate FAILED:', JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
console.log('config:validate OK — wi.config.json matches wi.config.schema.json');