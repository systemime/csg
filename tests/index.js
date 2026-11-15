'use strict';

// Node 24 把 `node --test tests/` 当作模块入口解析目录；这个入口让该命令可用。
require('./cli.test');
require('./hooks.test');
require('./events-monitor.test');
require('./service.test');
