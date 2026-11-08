'use strict';
// Loaded after ts_register.js, before each L1 unit-test file (also under node --test).
// No L2/Runtime/Storage implementation is loaded by this preloader.
const { installL1V2Mocks } = require('./l1V2UnitMocks.ts');
installL1V2Mocks();
