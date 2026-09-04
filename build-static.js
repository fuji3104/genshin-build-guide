#!/usr/bin/env node
/**
 * build-static.js
 *
 * index.html はキャラクターデータをすべて <script> 内の `DATA` 配列に埋め込んでおり、
 * JS実行前の生HTMLにはキャラ名・武器名・聖遺物名などが一切出現しない(いわゆる
 * "app shell" 構造)。これがSearch Consoleでの「クロール済み - インデックス未登録」の
 * 一因(Googleの言う "The design of the website might make indexing difficult.")と
 * 判断し、初回訪問者向けの静的プリレンダリングをビルド時に生成して埋め込む。
 *
 * 方針:
 * - index.html 内の `const DATA` を含む <script> ブロックを、素のNode(vmモジュール)で
 *   実際に実行する。DOM APIは何をされても無害に受け流すProxyスタブで代替する。
 * - スタブの localStorage.getItem は常に null を返す(= ownedState が空になる)。これは
 *   初回訪問者のブラウザの状態そのものなので、生成されるHTMLは実行時の render() が
 *   生成するHTMLと完全に一致する(表示上のちらつき・差分は発生しない)。
 * - 実行後にコンテキストから `DATA` と `card` を取り出し、DATA.map(card).join("") を
 *   このNodeスクリプト側で計算する(card()自体を実行するので手書き簡略版は作らない)。
 * - 生成物は index.html 内のマーカーコメント <!--PRERENDER:START/END--> と
 *   <!--COUNT:START/END--> の間だけを置換する(冪等)。
 *
 * 使い方: DATA や card() を変更したら、commit前に `node build-static.js` を実行すること。
 * 実行し忘れると、静的プリレンダリングとJSの実際の生成物が乖離してしまう。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const INDEX_PATH = path.join(__dirname, "index.html");

function extractAppScript(html) {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const appScript = blocks.find(b => b.includes("const DATA"));
  if (!appScript) {
    throw new Error("const DATA を含む <script> ブロックが見つかりませんでした。");
  }
  return appScript;
}

// --- 何をされても無害に受け流すno-opスタブ ---
// 関数としても呼び出せるProxyで、プロパティ取得は(明示的に代入済みの値がなければ)
// 自分自身を返す。addEventListener/setAttribute/appendChild/classList.toggle等、
// メソッド呼び出しは全て「引数を無視してスタブ自身を返す」no-opとして扱われる。
function createStub() {
  const store = Object.create(null);
  const fn = function () {
    return proxy;
  };
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === "then" || prop === "toJSON") {
        return undefined;
      }
      if (Object.prototype.hasOwnProperty.call(store, prop)) {
        return store[prop];
      }
      return proxy;
    },
    set(target, prop, value) {
      store[prop] = value;
      return true;
    },
    has() {
      return true;
    },
    // querySelectorAll等が万一 for...of / spread で回されても無限ループしないよう、
    // 空配列として振る舞うiteratorを提供する。
    getOwnPropertyDescriptor() {
      return { configurable: true, enumerable: true, value: undefined };
    },
  };
  const proxy = new Proxy(fn, handler);
  return proxy;
}

function buildSandbox() {
  const documentStub = createStub();
  const windowStub = createStub();
  const localStorageStub = {
    getItem() {
      return null; // 初回訪問者 = localStorageが空、を再現する
    },
    setItem() {},
    removeItem() {},
  };
  const consoleStub = { log() {}, warn() {}, error() {} };

  const sandbox = {
    document: documentStub,
    window: windowStub,
    localStorage: localStorageStub,
    console: consoleStub,
    // typeof gtag === "function" のガードで守られているため未定義のままでよいが、
    // 念のため安全なno-opとして定義しておく。
    gtag: function () {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

function renderPrerender(appScriptCode) {
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  // const/letは実行コンテキストのグローバルオブジェクトのプロパティにならないため、
  // 同一スコープ内でvarを使って明示的にエクスポートする。
  const codeToRun = appScriptCode + "\nvar __EXPORT__ = { DATA: DATA, card: card };\n";
  const script = new vm.Script(codeToRun, { filename: "app-script.js" });
  script.runInContext(context);

  const exported = context.__EXPORT__;
  if (!exported || !Array.isArray(exported.DATA) || typeof exported.card !== "function") {
    throw new Error("DATA または card を実行コンテキストから取り出せませんでした。");
  }
  const { DATA, card } = exported;
  const gridHtml = DATA.map(card).join("");
  const countText = `${DATA.length} / ${DATA.length} キャラクター`;
  return { gridHtml, countText, count: DATA.length };
}

function replaceBetweenMarkers(html, startMarker, endMarker, replacement) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`マーカーが見つかりませんでした: ${startMarker} / ${endMarker}`);
  }
  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  return before + replacement + after;
}

function main() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const appScriptCode = extractAppScript(html);
  const { gridHtml, countText, count } = renderPrerender(appScriptCode);

  let updated = html;
  updated = replaceBetweenMarkers(
    updated,
    "<!--PRERENDER:START-->",
    "<!--PRERENDER:END-->",
    gridHtml
  );
  updated = replaceBetweenMarkers(
    updated,
    "<!--COUNT:START-->",
    "<!--COUNT:END-->",
    countText
  );

  fs.writeFileSync(INDEX_PATH, updated, "utf8");
  console.log(`build-static.js: 完了 (DATA件数=${count})`);
}

main();
