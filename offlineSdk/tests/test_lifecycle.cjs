const { test } = require('node:test');
const { cases } = require('./helpers/lifecycle_cases.cjs');
for (const item of cases) test(item.name, item.run);
