'use strict';
if (process.platform !== 'linux') throw new Error('Run package:linux on Linux');
require('./package-desktop');
