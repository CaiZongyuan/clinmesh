const packages = '^src/packages/';
const internal = `${packages}[^/]+/(?!index\\.ts$)`;
const rule = (name, from, to) => ({ name, severity: 'error', from, to });

module.exports = {
  forbidden: [
    rule('entrypoint-boundary-from-app', { pathNot: packages }, { path: internal }),
    rule('entrypoint-boundary-across-packages', { path: `${packages}([^/]+)/` },
      { path: internal, pathNot: `${packages}$1/` }),
    rule('tests-through-entrypoints', { path: `${packages}([^/]+)/tests/` },
      { path: `${packages}$1/(?!index\\.ts$|tests/)` }),
    rule('tests-folder-is-private', { pathNot: `${packages}[^/]+/tests/` }, { path: `${packages}[^/]+/tests/` }),
    rule('no-server-importing-web', { path: '^src/server/' }, { path: '^src/web/' }),
    rule('no-web-importing-server', { path: '^src/web/' }, { path: '^src/server/' }),
    rule('core-never-imports-modules', { path: `${packages}(platform|store|data-pack|patient-visit|clinical-core)/` },
      { path: `${packages}mod-[^/]+/` }),
    rule('ports-never-import-core', { path: `${packages}(platform|store)/` },
      { path: `${packages}(data-pack|patient-visit|clinical-core)/` }),
    rule('no-circular', {}, { circular: true }),
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true, tsConfig: { fileName: 'tsconfig.json' } },
};
