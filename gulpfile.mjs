/* Copyright 2016 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */

import * as builder from "./external/builder/builder.mjs";
import { fileURLToPath } from "url";
import fs from "fs";
import gulp from "gulp";
import path from "path";
import replace from "gulp-replace";
import rimraf from "rimraf";
import webpack2 from "webpack";
import webpackStream from "webpack-stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILD_DIR = "build/";

const DEFAULT_PREFERENCES_DIR = BUILD_DIR + "default_preferences/";
const TMP_DIR = BUILD_DIR + "tmp/";

const ENV_TARGETS = [
  "last 2 versions",
  "Chrome >= 92",
  "Firefox ESR",
  "Safari >= 15.4",
  "Node >= 18",
  "> 1%",
  "not IE > 0",
  "not dead",
];

// Default Babel targets used for generic, components, minified-pre
const BABEL_TARGETS = ENV_TARGETS.join(", ");

const DEFINES = Object.freeze({
  SKIP_BABEL: true,
  TESTING: undefined,
  // The main build targets:
  GENERIC: false,
  MOZCENTRAL: false,
  GECKOVIEW: false,
  CHROME: false,
  MINIFIED: false,
  COMPONENTS: false,
  LIB: false,
  IMAGE_DECODERS: false,
});

function createWebpackConfig(
  defines,
  output,
  {
    disableVersionInfo = false,
    disableSourceMaps = false,
    disableLicenseHeader = false,
    defaultPreferencesDir = null,
  } = {}
) {
  const versionInfo = !disableVersionInfo
    ? getVersionJSON()
    : { version: 0, commit: 0 };
  const bundleDefines = builder.merge(defines, {
    BUNDLE_VERSION: versionInfo.version,
    BUNDLE_BUILD: versionInfo.commit,
    TESTING: defines.TESTING ?? process.env.TESTING === "true",
    DEFAULT_PREFERENCES: defaultPreferencesDir
      ? getDefaultPreferences(defaultPreferencesDir)
      : {},
  });
  const licenseHeaderLibre = fs
    .readFileSync("./src/license_header_libre.js")
    .toString();
  const enableSourceMaps =
    !bundleDefines.MOZCENTRAL &&
    !bundleDefines.CHROME &&
    !bundleDefines.LIB &&
    !bundleDefines.TESTING &&
    !disableSourceMaps;
  const skipBabel = bundleDefines.SKIP_BABEL;

  // `core-js` (see https://github.com/zloirock/core-js/issues/514), and
  // `src/core/{glyphlist,unicode}.js` (Babel is too slow for those when
  // source-maps are enabled) should be excluded from processing.
  const babelExcludes = ["node_modules[\\\\\\/]core-js"];
  if (enableSourceMaps) {
    babelExcludes.push("src[\\\\\\/]core[\\\\\\/](glyphlist|unicode)");
  }
  const babelExcludeRegExp = new RegExp(`(${babelExcludes.join("|")})`);

  const babelPresets = skipBabel
    ? undefined
    : [
        [
          "@babel/preset-env",
          { corejs: "3.31.1", shippedProposals: true, useBuiltIns: "usage" },
        ],
      ];
  const babelPlugins = ["@babel/plugin-transform-modules-commonjs"];

  const plugins = [];
  if (!disableLicenseHeader) {
    plugins.push(
      new webpack2.BannerPlugin({ banner: licenseHeaderLibre, raw: true })
    );
  }

  const experiments =
    output.library?.type === "module" ? { outputModule: true } : undefined;

  // Required to expose e.g., the `window` object.
  output.globalObject = "globalThis";

  const basicAlias = {
    pdfjs: "src",
    "pdfjs-web": "web",
    "pdfjs-lib": "web/pdfjs",
  };
  const libraryAlias = {
    "display-fetch_stream": "src/display/stubs.js",
    "display-l10n_utils": "src/display/stubs.js",
    "display-network": "src/display/stubs.js",
    "display-node_stream": "src/display/stubs.js",
    "display-node_utils": "src/display/stubs.js",
    "display-svg": "src/display/stubs.js",
  };
  const viewerAlias = {
    "web-annotation_editor_params": "web/annotation_editor_params.js",
    "web-com": "",
    "web-pdf_attachment_viewer": "web/pdf_attachment_viewer.js",
    "web-pdf_cursor_tools": "web/pdf_cursor_tools.js",
    "web-pdf_document_properties": "web/pdf_document_properties.js",
    "web-pdf_find_bar": "web/pdf_find_bar.js",
    "web-pdf_layer_viewer": "web/pdf_layer_viewer.js",
    "web-pdf_outline_viewer": "web/pdf_outline_viewer.js",
    "web-pdf_presentation_mode": "web/pdf_presentation_mode.js",
    "web-pdf_sidebar": "web/pdf_sidebar.js",
    "web-pdf_thumbnail_viewer": "web/pdf_thumbnail_viewer.js",
    "web-print_service": "",
    "web-secondary_toolbar": "web/secondary_toolbar.js",
    "web-toolbar": "web/toolbar.js",
  };
  if (bundleDefines.CHROME) {
    libraryAlias["display-fetch_stream"] = "src/display/fetch_stream.js";
    libraryAlias["display-network"] = "src/display/network.js";

    viewerAlias["web-com"] = "web/chromecom.js";
    viewerAlias["web-print_service"] = "web/pdf_print_service.js";
  } else if (bundleDefines.GENERIC) {
    libraryAlias["display-fetch_stream"] = "src/display/fetch_stream.js";
    libraryAlias["display-l10n_utils"] = "web/l10n_utils.js";
    libraryAlias["display-network"] = "src/display/network.js";
    libraryAlias["display-node_stream"] = "src/display/node_stream.js";
    libraryAlias["display-node_utils"] = "src/display/node_utils.js";
    libraryAlias["display-svg"] = "src/display/svg.js";

    viewerAlias["web-com"] = "web/genericcom.js";
    viewerAlias["web-print_service"] = "web/pdf_print_service.js";
  } else if (bundleDefines.MOZCENTRAL) {
    if (bundleDefines.GECKOVIEW) {
      const gvAlias = {
        "web-toolbar": "web/toolbar-geckoview.js",
      };
      for (const key in viewerAlias) {
        viewerAlias[key] = gvAlias[key] || "web/stubs-geckoview.js";
      }
    }
    viewerAlias["web-com"] = "web/firefoxcom.js";
    viewerAlias["web-print_service"] = "web/firefox_print_service.js";
  }
  const alias = { ...basicAlias, ...libraryAlias, ...viewerAlias };
  for (const key in alias) {
    alias[key] = path.join(__dirname, alias[key]);
  }

  return {
    mode: "none",
    experiments,
    output,
    performance: {
      hints: false, // Disable messages about larger file sizes.
    },
    plugins,
    resolve: {
      alias,
    },
    devtool: enableSourceMaps ? "source-map" : undefined,
    module: {
      rules: [
        {
          loader: "babel-loader",
          exclude: babelExcludeRegExp,
          options: {
            presets: babelPresets,
            plugins: babelPlugins,
            targets: BABEL_TARGETS,
          },
        },
        {
          loader: path.join(__dirname, "external/webpack/pdfjsdev-loader.mjs"),
          options: {
            rootPath: __dirname,
            saveComments: false,
            defines: bundleDefines,
          },
        },
      ],
    },
    // Avoid shadowing actual Node.js variables with polyfills, by disabling
    // polyfills/mocks - https://webpack.js.org/configuration/node/
    node: false,
  };
}

function webpack2Stream(webpackConfig) {
  // Replacing webpack1 to webpack2 in the webpack-stream.
  return webpackStream(webpackConfig, webpack2);
}

function getVersionJSON() {
  return JSON.parse(fs.readFileSync(BUILD_DIR + "version.json").toString());
}

function replaceWebpackRequire() {
  // Produced bundles can be rebundled again, avoid collisions (e.g. in api.js)
  // by renaming  __webpack_require__ to something else.
  return replace("__webpack_require__", "__w_pdfjs_require__");
}

function replaceNonWebpackImport() {
  return replace("__non_webpack_import__", "import");
}

function replaceJSRootName(amdName, jsName) {
  // Saving old-style JS module name.
  return replace(
    'root["' + amdName + '"] = factory()',
    'root["' + amdName + '"] = root.' + jsName + " = factory()"
  );
}

function createScriptingBundle(defines, extraOptions = undefined) {
  const scriptingAMDName = "pdfjs-dist/build/pdf.scripting";
  const scriptingOutputName = "pdf.scripting.js";

  const scriptingFileConfig = createWebpackConfig(
    defines,
    {
      filename: scriptingOutputName,
      library: scriptingAMDName,
      libraryTarget: "umd",
      umdNamedDefine: true,
    },
    extraOptions
  );
  return gulp
    .src("./src/pdf.scripting.js")
    .pipe(webpack2Stream(scriptingFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(
      replace(
        'root["' + scriptingAMDName + '"] = factory()',
        "root.pdfjsScripting = factory()"
      )
    );
}

function createTemporaryScriptingBundle(defines, extraOptions = undefined) {
  return createScriptingBundle(defines, {
    disableVersionInfo: !!(extraOptions && extraOptions.disableVersionInfo),
    disableSourceMaps: true,
    disableLicenseHeader: true,
  }).pipe(gulp.dest(TMP_DIR));
}

function createSandboxBundle(defines, extraOptions = undefined) {
  const sandboxAMDName = "pdfjs-dist/build/pdf.sandbox";
  const sandboxOutputName = "pdf.sandbox.js";

  const scriptingPath = TMP_DIR + "pdf.scripting.js";
  // Insert the source as a string to be `eval`-ed in the sandbox.
  const sandboxDefines = builder.merge(defines, {
    PDF_SCRIPTING_JS_SOURCE: fs.readFileSync(scriptingPath).toString(),
  });
  fs.unlinkSync(scriptingPath);

  const sandboxFileConfig = createWebpackConfig(
    sandboxDefines,
    {
      filename: sandboxOutputName,
      library: sandboxAMDName,
      libraryTarget: "umd",
      umdNamedDefine: true,
    },
    extraOptions
  );

  return gulp
    .src("./src/pdf.sandbox.js")
    .pipe(webpack2Stream(sandboxFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(replaceJSRootName(sandboxAMDName, "pdfjsSandbox"));
}

function getDefaultPreferences(dir) {
  const str = fs
    .readFileSync(DEFAULT_PREFERENCES_DIR + dir + "default_preferences.json")
    .toString();
  return JSON.parse(str);
}

gulp.task(
  "dev-sandbox",
  gulp.series(
    function scriptingDevSandbox() {
      const defines = builder.merge(DEFINES, { GENERIC: true, TESTING: true });
      return createTemporaryScriptingBundle(defines, {
        disableVersionInfo: true,
      });
    },
    function createDevSandbox() {
      console.log();
      console.log("### Building development sandbox");

      const defines = builder.merge(DEFINES, { GENERIC: true, TESTING: true });
      const sandboxDir = BUILD_DIR + "dev-sandbox/";

      rimraf.sync(sandboxDir);

      return createSandboxBundle(defines, {
        disableVersionInfo: true,
      }).pipe(gulp.dest(sandboxDir));
    }
  )
);

gulp.task(
  "server",
  gulp.parallel(
    function watchDevSandbox() {
      gulp.watch(
        [
          "src/pdf.{sandbox,sandbox.external,scripting}.js",
          "src/scripting_api/*.js",
          "src/shared/scripting_utils.js",
          "external/quickjs/*.js",
        ],
        { ignoreInitial: false },
        gulp.series("dev-sandbox")
      );
    },
    async function createServer() {
      console.log();
      console.log("### Starting local server");

      const { WebServer } = await import("./test/webserver.mjs");
      const server = new WebServer();
      server.port = 8888;
      server.start();
    }
  )
);
