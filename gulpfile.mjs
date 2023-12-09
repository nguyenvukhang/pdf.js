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
import { exec, spawn } from "child_process";
import autoprefixer from "autoprefixer";
import babel from "@babel/core";
import crypto from "crypto";
import { fileURLToPath } from "url";
import fs from "fs";
import gulp from "gulp";
import merge from "merge-stream";
import { mkdirp } from "mkdirp";
import path from "path";
import postcss from "gulp-postcss";
import postcssDirPseudoClass from "postcss-dir-pseudo-class";
import { preprocessPDFJSCode } from "./external/builder/preprocessor2.mjs";
import rename from "gulp-rename";
import replace from "gulp-replace";
import rimraf from "rimraf";
import stream from "stream";
import streamqueue from "streamqueue";
import through from "through2";
import Vinyl from "vinyl";
import webpack2 from "webpack";
import webpackStream from "webpack-stream";
import zip from "gulp-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILD_DIR = "build/";
const L10N_DIR = "l10n/";
const TEST_DIR = "test/";
const EXTENSION_SRC_DIR = "extensions/";

const BASELINE_DIR = BUILD_DIR + "baseline/";
const GENERIC_DIR = BUILD_DIR + "generic/";
const GENERIC_LEGACY_DIR = BUILD_DIR + "generic-legacy/";
const COMPONENTS_DIR = BUILD_DIR + "components/";
const COMPONENTS_LEGACY_DIR = BUILD_DIR + "components-legacy/";
const IMAGE_DECODERS_DIR = BUILD_DIR + "image_decoders/";
const IMAGE_DECODERS_LEGACY_DIR = BUILD_DIR + "image_decoders-legacy/";
const DEFAULT_PREFERENCES_DIR = BUILD_DIR + "default_preferences/";
const MINIFIED_DIR = BUILD_DIR + "minified/";
const MINIFIED_LEGACY_DIR = BUILD_DIR + "minified-legacy/";
const JSDOC_BUILD_DIR = BUILD_DIR + "jsdoc/";
const SRC_DIR = "src/";
const TYPES_DIR = BUILD_DIR + "types/";
const TMP_DIR = BUILD_DIR + "tmp/";
const TYPESTEST_DIR = BUILD_DIR + "typestest/";
const COMMON_WEB_FILES = [
  "web/images/*.{png,svg,gif}",
  "web/debugger.{css,js}",
];

const CONFIG_FILE = "pdfjs.config";
const config = JSON.parse(fs.readFileSync(CONFIG_FILE).toString());

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

// Default Autoprefixer config used for generic, components, minified-pre
const AUTOPREFIXER_CONFIG = {
  overrideBrowserslist: ENV_TARGETS,
};
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

function transform(charEncoding, transformFunction) {
  return through.obj(function (vinylFile, enc, done) {
    const transformedFile = vinylFile.clone();
    transformedFile.contents = Buffer.from(
      transformFunction(transformedFile.contents),
      charEncoding
    );
    done(null, transformedFile);
  });
}

function startNode(args, options) {
  // Node.js decreased the maximum header size from 80 KB to 8 KB in newer
  // releases, which is not sufficient for some of our reference test files
  // (such as `issue6360.pdf`), so we need to restore this value. Note that
  // this argument needs to be before all other arguments as it needs to be
  // passed to the Node.js process itself and not to the script that it runs.
  args.unshift("--max-http-header-size=80000");
  return spawn("node", args, options);
}

function createStringSource(filename, content) {
  const source = stream.Readable({ objectMode: true });
  source._read = function () {
    this.push(
      new Vinyl({
        path: filename,
        contents: Buffer.from(content),
      })
    );
    this.push(null);
  };
  return source;
}

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

function checkChromePreferencesFile(chromePrefsPath, webPrefs) {
  const chromePrefs = JSON.parse(fs.readFileSync(chromePrefsPath).toString());
  const chromePrefsKeys = Object.keys(chromePrefs.properties).filter(key => {
    const description = chromePrefs.properties[key].description;
    // Deprecated keys are allowed in the managed preferences file.
    // The code maintainer is responsible for adding migration logic to
    // extensions/chromium/options/migration.js and web/chromecom.js .
    return !description || !description.startsWith("DEPRECATED.");
  });

  let ret = true;
  // Verify that every entry in webPrefs is also in preferences_schema.json.
  for (const [key, value] of Object.entries(webPrefs)) {
    if (!chromePrefsKeys.includes(key)) {
      // Note: this would also reject keys that are present but marked as
      // DEPRECATED. A key should not be marked as DEPRECATED if it is still
      // listed in webPrefs.
      ret = false;
      console.log(
        `Warning: ${chromePrefsPath} does not contain an entry for pref: ${key}`
      );
    } else if (chromePrefs.properties[key].default !== value) {
      ret = false;
      console.log(
        `Warning: not the same values (for "${key}"): ` +
          `${chromePrefs.properties[key].default} !== ${value}`
      );
    }
  }

  // Verify that preferences_schema.json does not contain entries that are not
  // in webPrefs (app_options.js).
  for (const key of chromePrefsKeys) {
    if (!(key in webPrefs)) {
      ret = false;
      console.log(
        `Warning: ${chromePrefsPath} contains an unrecognized pref: ${key}. ` +
          `Remove it, or prepend "DEPRECATED. " and add migration logic to ` +
          `extensions/chromium/options/migration.js and web/chromecom.js.`
      );
    }
  }
  return ret;
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

function createMainBundle(defines) {
  const mainAMDName = "pdfjs-dist/build/pdf";
  const mainOutputName = "pdf.js";

  const mainFileConfig = createWebpackConfig(defines, {
    filename: mainOutputName,
    library: mainAMDName,
    libraryTarget: "umd",
    umdNamedDefine: true,
  });
  return gulp
    .src("./src/pdf.js")
    .pipe(webpack2Stream(mainFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(replaceJSRootName(mainAMDName, "pdfjsLib"));
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

function createSandboxExternal(defines) {
  const licenseHeader = fs.readFileSync("./src/license_header.js").toString();

  const ctx = {
    saveComments: false,
    defines,
  };
  return gulp
    .src("./src/pdf.sandbox.external.js")
    .pipe(rename("pdf.sandbox.external.sys.mjs"))
    .pipe(
      transform("utf8", content => {
        content = preprocessPDFJSCode(ctx, content);
        return `${licenseHeader}\n${content}`;
      })
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

function createWorkerBundle(defines) {
  const workerAMDName = "pdfjs-dist/build/pdf.worker";
  const workerOutputName = "pdf.worker.js";

  const workerFileConfig = createWebpackConfig(defines, {
    filename: workerOutputName,
    library: workerAMDName,
    libraryTarget: "umd",
    umdNamedDefine: true,
  });
  return gulp
    .src("./src/pdf.worker.js")
    .pipe(webpack2Stream(workerFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(replaceJSRootName(workerAMDName, "pdfjsWorker"));
}

function createWebBundle(defines, options) {
  const viewerOutputName = "viewer.js";

  const viewerFileConfig = createWebpackConfig(
    defines,
    {
      filename: viewerOutputName,
    },
    {
      defaultPreferencesDir: options.defaultPreferencesDir,
    }
  );
  return gulp
    .src("./web/viewer.js")
    .pipe(webpack2Stream(viewerFileConfig))
    .pipe(replaceNonWebpackImport());
}

function createGVWebBundle(defines, options) {
  const viewerOutputName = "viewer-geckoview.js";
  defines = builder.merge(defines, { GECKOVIEW: true });

  const viewerFileConfig = createWebpackConfig(
    defines,
    {
      filename: viewerOutputName,
    },
    {
      defaultPreferencesDir: options.defaultPreferencesDir,
    }
  );
  return gulp
    .src("./web/viewer-geckoview.js")
    .pipe(webpack2Stream(viewerFileConfig))
    .pipe(replaceNonWebpackImport());
}

function createComponentsBundle(defines) {
  const componentsAMDName = "pdfjs-dist/web/pdf_viewer";
  const componentsOutputName = "pdf_viewer.js";

  const componentsFileConfig = createWebpackConfig(defines, {
    filename: componentsOutputName,
    library: componentsAMDName,
    libraryTarget: "umd",
    umdNamedDefine: true,
  });
  return gulp
    .src("./web/pdf_viewer.component.js")
    .pipe(webpack2Stream(componentsFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(replaceJSRootName(componentsAMDName, "pdfjsViewer"));
}

function createImageDecodersBundle(defines) {
  const imageDecodersAMDName = "pdfjs-dist/image_decoders/pdf.image_decoders";
  const imageDecodersOutputName = "pdf.image_decoders.js";

  const componentsFileConfig = createWebpackConfig(defines, {
    filename: imageDecodersOutputName,
    library: imageDecodersAMDName,
    libraryTarget: "umd",
    umdNamedDefine: true,
  });
  return gulp
    .src("./src/pdf.image_decoders.js")
    .pipe(webpack2Stream(componentsFileConfig))
    .pipe(replaceWebpackRequire())
    .pipe(replaceNonWebpackImport())
    .pipe(replaceJSRootName(imageDecodersAMDName, "pdfjsImageDecoders"));
}

function createCMapBundle() {
  return gulp.src(["external/bcmaps/*.bcmap", "external/bcmaps/LICENSE"], {
    base: "external/bcmaps",
  });
}

function createStandardFontBundle() {
  return gulp.src(
    [
      "external/standard_fonts/*.pfb",
      "external/standard_fonts/*.ttf",
      "external/standard_fonts/LICENSE_FOXIT",
      "external/standard_fonts/LICENSE_LIBERATION",
    ],
    {
      base: "external/standard_fonts",
    }
  );
}

function checkFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function checkDir(dirPath) {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function replaceInFile(filePath, find, replacement) {
  let content = fs.readFileSync(filePath).toString();
  content = content.replace(find, replacement);
  fs.writeFileSync(filePath, content);
}

function getTempFile(prefix, suffix) {
  mkdirp.sync(BUILD_DIR + "tmp/");
  const bytes = crypto.randomBytes(6).toString("hex");
  const filePath = BUILD_DIR + "tmp/" + prefix + bytes + suffix;
  fs.writeFileSync(filePath, "");
  return filePath;
}

function createTestSource(testsName, { bot = false, xfaOnly = false } = {}) {
  const source = stream.Readable({ objectMode: true });
  source._read = function () {
    console.log();
    console.log("### Running " + testsName + " tests");

    const PDF_TEST = process.env.PDF_TEST || "test_manifest.json";
    let forceNoChrome = false;
    const args = ["test.mjs"];
    switch (testsName) {
      case "browser":
        if (!bot) {
          args.push("--reftest");
        } else {
          const os = process.env.OS;
          if (/windows/i.test(os)) {
            // The browser-tests are too slow in Google Chrome on the Windows
            // bot, causing a timeout, hence disabling them for now.
            forceNoChrome = true;
          }
        }
        if (xfaOnly) {
          args.push("--xfaOnly");
        }
        args.push("--manifestFile=" + PDF_TEST);
        break;
      case "unit":
        args.push("--unitTest");
        break;
      case "font":
        args.push("--fontTest");
        break;
      case "integration":
        args.push("--integration");
        break;
      default:
        this.emit("error", new Error("Unknown name: " + testsName));
        return null;
    }
    if (bot) {
      args.push("--strictVerify");
    }
    if (process.argv.includes("--noChrome") || forceNoChrome) {
      args.push("--noChrome");
    }

    const testProcess = startNode(args, { cwd: TEST_DIR, stdio: "inherit" });
    testProcess.on("close", function (_) {
      source.push(null);
    });
    return undefined;
  };
  return source;
}

function makeRef(done, bot) {
  console.log();
  console.log("### Creating reference images");

  let forceNoChrome = false;
  const args = ["test.mjs", "--masterMode"];
  if (bot) {
    const os = process.env.OS;
    if (/windows/i.test(os)) {
      // The browser-tests are too slow in Google Chrome on the Windows
      // bot, causing a timeout, hence disabling them for now.
      forceNoChrome = true;
    }
    args.push("--noPrompts", "--strictVerify");
  }
  if (process.argv.includes("--noChrome") || forceNoChrome) {
    args.push("--noChrome");
  }

  const testProcess = startNode(args, { cwd: TEST_DIR, stdio: "inherit" });
  testProcess.on("close", function (_) {
    done();
  });
}

function createBuildNumber(done) {
  console.log();
  console.log("### Getting extension build number");

  exec(
    "git log --format=oneline " + config.baseVersion + "..",
    function (err, stdout, _) {
      let buildNumber = 0;
      if (!err) {
        // Build number is the number of commits since base version
        buildNumber = stdout ? stdout.match(/\n/g).length : 0;
      } else {
        console.log(
          "This is not a Git repository; using default build number."
        );
      }

      console.log("Extension build number: " + buildNumber);

      const version = config.versionPrefix + buildNumber;

      exec('git log --format="%h" -n 1', function (err2, stdout2, _) {
        let buildCommit = "";
        if (!err2) {
          buildCommit = stdout2.replace("\n", "");
        }

        createStringSource(
          "version.json",
          JSON.stringify(
            {
              version,
              build: buildNumber,
              commit: buildCommit,
            },
            null,
            2
          )
        )
          .pipe(gulp.dest(BUILD_DIR))
          .on("end", done);
      });
    }
  );
}

function buildDefaultPreferences(defines, dir) {
  console.log();
  console.log("### Building default preferences");

  const bundleDefines = builder.merge(defines, {
    LIB: true,
    TESTING: defines.TESTING ?? process.env.TESTING === "true",
  });

  const defaultPreferencesConfig = createWebpackConfig(
    bundleDefines,
    {
      filename: "app_options.mjs",
      library: {
        type: "module",
      },
    },
    {
      disableVersionInfo: true,
    }
  );
  return gulp
    .src("web/app_options.js")
    .pipe(webpack2Stream(defaultPreferencesConfig))
    .pipe(gulp.dest(DEFAULT_PREFERENCES_DIR + dir));
}

async function parseDefaultPreferences(dir) {
  console.log();
  console.log("### Parsing default preferences");

  // eslint-disable-next-line no-unsanitized/method
  const { AppOptions, OptionKind } = await import(
    "./" + DEFAULT_PREFERENCES_DIR + dir + "app_options.mjs"
  );

  const prefs = AppOptions.getAll(OptionKind.PREFERENCE);
  if (Object.keys(prefs).length === 0) {
    throw new Error("No default preferences found.");
  }

  fs.writeFileSync(
    DEFAULT_PREFERENCES_DIR + dir + "default_preferences.json",
    JSON.stringify(prefs)
  );
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

function preprocessCSS(source, defines) {
  const outName = getTempFile("~preprocess", ".css");
  builder.preprocess(source, outName, defines);
  let out = fs.readFileSync(outName).toString();
  fs.unlinkSync(outName);

  // Strip out all license headers in the middle.
  const reg = /\n\/\* Copyright(.|\n)*?Mozilla Foundation(.|\n)*?\*\//g;
  out = out.replaceAll(reg, "");

  const i = source.lastIndexOf("/");
  return createStringSource(source.substr(i + 1), out);
}

function preprocessHTML(source, defines) {
  const outName = getTempFile("~preprocess", ".html");
  builder.preprocess(source, outName, defines);
  const out = fs.readFileSync(outName).toString();
  fs.unlinkSync(outName);

  const i = source.lastIndexOf("/");
  return createStringSource(source.substr(i + 1), `${out.trimEnd()}\n`);
}

function buildGeneric(defines, dir) {
  rimraf.sync(dir);

  return merge([
    createMainBundle(defines).pipe(gulp.dest(dir + "build")),
    createWorkerBundle(defines).pipe(gulp.dest(dir + "build")),
    createSandboxBundle(defines).pipe(gulp.dest(dir + "build")),
    createWebBundle(defines, {
      defaultPreferencesDir: defines.SKIP_BABEL
        ? "generic/"
        : "generic-legacy/",
    }).pipe(gulp.dest(dir + "web")),
    gulp.src(COMMON_WEB_FILES, { base: "web/" }).pipe(gulp.dest(dir + "web")),
    gulp.src("LICENSE").pipe(gulp.dest(dir)),
    gulp
      .src(["web/locale/*/viewer.properties", "web/locale/locale.properties"], {
        base: "web/",
      })
      .pipe(gulp.dest(dir + "web")),
    createCMapBundle().pipe(gulp.dest(dir + "web/cmaps")),
    createStandardFontBundle().pipe(gulp.dest(dir + "web/standard_fonts")),

    preprocessHTML("web/viewer.html", defines).pipe(gulp.dest(dir + "web")),
    preprocessCSS("web/viewer.css", defines)
      .pipe(
        postcss([postcssDirPseudoClass(), autoprefixer(AUTOPREFIXER_CONFIG)])
      )
      .pipe(gulp.dest(dir + "web")),

    gulp
      .src("web/compressed.tracemonkey-pldi-09.pdf")
      .pipe(gulp.dest(dir + "web")),
  ]);
}

// Builds the generic production viewer that is only compatible with up-to-date
// HTML5 browsers, which implement modern ECMAScript features.

// Builds the generic production viewer that should be compatible with most
// older HTML5 browsers.

function buildComponents(defines, dir) {
  rimraf.sync(dir);

  const COMPONENTS_IMAGES = [
    "web/images/annotation-*.svg",
    "web/images/loading-icon.gif",
  ];

  return merge([
    createComponentsBundle(defines).pipe(gulp.dest(dir)),
    gulp.src(COMPONENTS_IMAGES).pipe(gulp.dest(dir + "images")),
    preprocessCSS("web/pdf_viewer.css", defines)
      .pipe(
        postcss([postcssDirPseudoClass(), autoprefixer(AUTOPREFIXER_CONFIG)])
      )
      .pipe(gulp.dest(dir)),
  ]);
}

function buildMinified(defines, dir) {
  rimraf.sync(dir);

  return merge([
    createMainBundle(defines).pipe(gulp.dest(dir + "build")),
    createWorkerBundle(defines).pipe(gulp.dest(dir + "build")),
    createSandboxBundle(defines).pipe(gulp.dest(dir + "build")),
    createWebBundle(defines, {
      defaultPreferencesDir: defines.SKIP_BABEL
        ? "minified/"
        : "minified-legacy/",
    }).pipe(gulp.dest(dir + "web")),
    createImageDecodersBundle(
      builder.merge(defines, { IMAGE_DECODERS: true })
    ).pipe(gulp.dest(dir + "image_decoders")),
    gulp.src(COMMON_WEB_FILES, { base: "web/" }).pipe(gulp.dest(dir + "web")),
    gulp
      .src(["web/locale/*/viewer.properties", "web/locale/locale.properties"], {
        base: "web/",
      })
      .pipe(gulp.dest(dir + "web")),
    createCMapBundle().pipe(gulp.dest(dir + "web/cmaps")),
    createStandardFontBundle().pipe(gulp.dest(dir + "web/standard_fonts")),

    preprocessHTML("web/viewer.html", defines).pipe(gulp.dest(dir + "web")),
    preprocessCSS("web/viewer.css", defines)
      .pipe(
        postcss([postcssDirPseudoClass(), autoprefixer(AUTOPREFIXER_CONFIG)])
      )
      .pipe(gulp.dest(dir + "web")),

    gulp
      .src("web/compressed.tracemonkey-pldi-09.pdf")
      .pipe(gulp.dest(dir + "web")),
  ]);
}

async function parseMinified(dir) {
  const pdfFile = fs.readFileSync(dir + "/build/pdf.js").toString();
  const pdfWorkerFile = fs
    .readFileSync(dir + "/build/pdf.worker.js")
    .toString();
  const pdfSandboxFile = fs
    .readFileSync(dir + "/build/pdf.sandbox.js")
    .toString();
  const pdfImageDecodersFile = fs
    .readFileSync(dir + "/image_decoders/pdf.image_decoders.js")
    .toString();
  const viewerFiles = {
    "pdf.js": pdfFile,
    "viewer.js": fs.readFileSync(dir + "/web/viewer.js").toString(),
  };

  console.log();
  console.log("### Minifying js files");

  const { minify } = await import("terser");
  const options = {
    compress: {
      // V8 chokes on very long sequences, work around that.
      sequences: false,
    },
    keep_classnames: true,
    keep_fnames: true,
  };

  fs.writeFileSync(
    dir + "/web/pdf.viewer.js",
    (await minify(viewerFiles, options)).code
  );
  fs.writeFileSync(
    dir + "/build/pdf.min.js",
    (await minify(pdfFile, options)).code
  );
  fs.writeFileSync(
    dir + "/build/pdf.worker.min.js",
    (await minify(pdfWorkerFile, options)).code
  );
  fs.writeFileSync(
    dir + "/build/pdf.sandbox.min.js",
    (await minify(pdfSandboxFile, options)).code
  );
  fs.writeFileSync(
    dir + "image_decoders/pdf.image_decoders.min.js",
    (await minify(pdfImageDecodersFile, options)).code
  );

  console.log();
  console.log("### Cleaning js files");

  fs.unlinkSync(dir + "/web/viewer.js");
  fs.unlinkSync(dir + "/web/debugger.js");
  fs.unlinkSync(dir + "/build/pdf.js");
  fs.unlinkSync(dir + "/build/pdf.worker.js");
  fs.unlinkSync(dir + "/build/pdf.sandbox.js");

  fs.renameSync(dir + "/build/pdf.min.js", dir + "/build/pdf.js");
  fs.renameSync(dir + "/build/pdf.worker.min.js", dir + "/build/pdf.worker.js");
  fs.renameSync(
    dir + "/build/pdf.sandbox.min.js",
    dir + "/build/pdf.sandbox.js"
  );
  fs.renameSync(
    dir + "/image_decoders/pdf.image_decoders.min.js",
    dir + "/image_decoders/pdf.image_decoders.js"
  );
}

function preprocessDefaultPreferences(content) {
  const licenseHeader = fs.readFileSync("./src/license_header.js").toString();

  const MODIFICATION_WARNING =
    "//\n// THIS FILE IS GENERATED AUTOMATICALLY, DO NOT EDIT MANUALLY!\n//\n";

  const bundleDefines = builder.merge(DEFINES, {
    DEFAULT_PREFERENCES: getDefaultPreferences("mozcentral/"),
  });

  content = preprocessPDFJSCode(
    {
      rootPath: __dirname,
      defines: bundleDefines,
    },
    content
  );

  return licenseHeader + "\n" + MODIFICATION_WARNING + "\n" + content + "\n";
}

function replaceMozcentralCSS() {
  return replace(/var\(--(inline-(?:start|end))\)/g, "$1");
}

function buildLibHelper(bundleDefines, inputStream, outputDir) {
  // When we create a bundle, webpack is run on the source and it will replace
  // require with __webpack_require__. When we want to use the real require,
  // __non_webpack_require__ has to be used.
  // In this target, we don't create a bundle, so we have to replace the
  // occurrences of __non_webpack_require__ ourselves.
  function babelPluginReplaceNonWebpackImports(b) {
    return {
      visitor: {
        Identifier(curPath, state) {
          if (curPath.node.name === "__non_webpack_require__") {
            curPath.replaceWith(b.types.identifier("require"));
          } else if (curPath.node.name === "__non_webpack_import__") {
            curPath.replaceWith(b.types.identifier("import"));
          }
        },
      },
    };
  }
  function preprocess(content) {
    const skipBabel =
      bundleDefines.SKIP_BABEL || /\/\*\s*no-babel-preset\s*\*\//.test(content);
    content = preprocessPDFJSCode(ctx, content);
    content = babel.transform(content, {
      sourceType: "module",
      presets: skipBabel ? undefined : ["@babel/preset-env"],
      plugins: [
        "@babel/plugin-transform-modules-commonjs",
        babelPluginReplaceNonWebpackImports,
      ],
      targets: BABEL_TARGETS,
    }).code;
    const removeCjsSrc =
      /^(var\s+\w+\s*=\s*(_interopRequireDefault\()?require\(".*?)(?:\/src)(\/[^"]*"\)\)?;)$/gm;
    content = content.replaceAll(
      removeCjsSrc,
      (all, prefix, interop, suffix) => prefix + suffix
    );
    return licenseHeaderLibre + content;
  }
  const ctx = {
    rootPath: __dirname,
    saveComments: false,
    defines: bundleDefines,
    map: {
      "pdfjs-lib": "../pdf",
      "display-fetch_stream": "./fetch_stream",
      "display-l10n_utils": "../web/l10n_utils",
      "display-network": "./network",
      "display-node_stream": "./node_stream",
      "display-node_utils": "./node_utils",
      "display-svg": "./svg",
    },
  };
  const licenseHeaderLibre = fs
    .readFileSync("./src/license_header_libre.js")
    .toString();
  return inputStream
    .pipe(transform("utf8", preprocess))
    .pipe(gulp.dest(outputDir));
}

function buildLib(defines, dir) {
  const versionInfo = getVersionJSON();

  const bundleDefines = builder.merge(defines, {
    BUNDLE_VERSION: versionInfo.version,
    BUNDLE_BUILD: versionInfo.commit,
    TESTING: defines.TESTING ?? process.env.TESTING === "true",
    DEFAULT_PREFERENCES: getDefaultPreferences(
      defines.SKIP_BABEL ? "lib/" : "lib-legacy/"
    ),
  });

  const inputStream = merge([
    gulp.src(
      [
        "src/{core,display,shared}/**/*.js",
        "!src/shared/{cffStandardStrings,fonts_utils}.js",
        "src/{pdf,pdf.image_decoders,pdf.worker}.js",
      ],
      { base: "src/" }
    ),
    gulp.src(
      [
        "examples/node/domstubs.js",
        "external/webL10n/l10n.js",
        "web/*.js",
        "!web/{pdfjs,viewer}.js",
      ],
      { base: "." }
    ),
    gulp.src("test/unit/*.js", { base: "." }),
  ]);

  return buildLibHelper(bundleDefines, inputStream, dir);
}

function compressPublish(targetName, dir) {
  return gulp
    .src(dir + "**")
    .pipe(zip(targetName))
    .pipe(gulp.dest(BUILD_DIR))
    .on("end", function () {
      console.log("Built distribution file: " + targetName);
    });
}

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
