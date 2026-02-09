#!/usr/bin/env node

'use strict';

const { run } = require('../lib/installer');

run().catch((err) => {
  console.error(`\n❌ Unexpected error: ${err.message}`);
  process.exit(1);
});
