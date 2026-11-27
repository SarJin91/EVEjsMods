"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { DELIVERY_KEY, MAX_SIGNED_FUNC_BYTES, MAX_OWN_PAYLOAD_BYTES, CODE_NAME, STUB_NAME, STUB_SOURCE, buildPayload,
  createClientDelivery } = require("../../lib/adapter/clientDelivery");
const { TAIL } = require("../../lib/adapter/handshakeHook");
const { formatTelemetry } = require("../../lib/core/telemetry");
const { SERVICE_NAME, NOTIFY, WIRE_VERSION: SERVICE_WIRE_VERSION } = require("../../lib/adapter/clientService");
const { WIRE_VERSION, REPORT_PROTO, MAX_VERB_CHARS, MAX_REPORT_ITEMS, MAX_REPORT_ITEM_CHARS, EVENT_PREFIX,
  parseReportItem } = require("../../lib/channels/clientWindow");

const WING_PY = path.resolve(__dirname, "..", "..", "client", "wing.py");

function marshaled(expr) {
  const buf = Buffer.alloc(5 + expr.length);
  buf[0] = 0x74;
  buf.writeInt32LE(expr.length, 1);
  buf.write(expr, 5, "ascii");
  return buf;
}

function ready() {
  const payload = buildPayload(fs.readFileSync(WING_PY, "utf8"));
  assert.strictEqual(payload.ok, true);
  const delivery = createClientDelivery({ encoded: payload.encoded });
  delivery.setReady(true);
  return { payload, delivery };
}

module.exports = ({ test }) => {
  test("CD1 compose: 0x74 header, length, ASCII, original expression unchanged, base64 -> inflate = wing.py; "
    + "the SAME object back when not ready, bad header, bad length, > 256 KB", () => {
    const { delivery } = ready();
    const expr = "eval(compile(\"print 'tidi'\", \"<tidi>\", \"exec\"))";
    const original = marshaled(expr);
    const out = delivery.compose(original);
    assert.notStrictEqual(out, original);
    assert.strictEqual(out[0], 0x74);
    assert.strictEqual(out.readUInt32LE(1), out.length - 5);
    const text = out.toString("latin1", 5);
    assert.ok(/^[\x00-\x7f]*$/.test(text), "ASCII only");
    assert.ok(text.endsWith(`, _sw_r)[1])(${expr})`), "original expression is the lambda argument");
    const b64 = /'_sw_b': '([A-Za-z0-9+/=]+)'/.exec(text)[1];
    assert.strictEqual(zlib.inflateSync(Buffer.from(b64, "base64")).toString("ascii"),
      fs.readFileSync(WING_PY, "utf8"));
    assert.ok(text.includes("'_sw_context': globals()"));

    const badHeader = Buffer.from(original);
    badHeader[0] = 0x73;
    const badLength = Buffer.from(original);
    badLength.writeUInt32LE(1, 1);
    const big = marshaled(`(${"1".repeat(MAX_SIGNED_FUNC_BYTES - 100)})`);
    const nonAscii = Buffer.concat([original.subarray(0, 5), Buffer.alloc(original.length - 5, 0xe9)]);
    for (const buf of [badHeader, badLength, big, nonAscii, Buffer.alloc(3)]) {
      assert.strictEqual(delivery.compose(buf), buf);
    }
    assert.strictEqual(delivery.compose("text"), "text");
    delivery.setReady(false);
    assert.strictEqual(delivery.compose(original), original);
    assert.deepStrictEqual(delivery.stats(), { ready: false, counters: { composed: 1, "skipped.badHeader": 5,
      "skipped.tooLarge": 1, "skipped.notReady": 1 } });
    assert.ok(formatTelemetry({ delivery: delivery.stats() }).endsWith(" client.delivery.composed=1 "
      + "client.delivery.skipped.badHeader=5 client.delivery.skipped.notReady=1 client.delivery.skipped.tooLarge=1"));
  });

  test("CD2 JS tail in vm.runInNewContext: calls the previous function once and returns compose(); compose "
    + "throws -> original; no delivery symbol -> original", () => {
    const run = (sandboxDelivery) => {
      const sandbox = { calls: 0, result: null };
      if (sandboxDelivery !== undefined) sandbox[DELIVERY_KEY] = sandboxDelivery;
      vm.runInNewContext(`function buildTidiSignedFunc(id) { calls += 1; return "orig:" + id; }\n${TAIL}`
        + "result = buildTidiSignedFunc(7);", sandbox);
      return sandbox;
    };
    const ok = run({ compose: (original) => `wrapped(${original})` });
    assert.deepStrictEqual([ok.calls, ok.result], [1, "wrapped(orig:7)"]);
    const thrown = run({ compose: () => { throw new Error("boom"); } });
    assert.deepStrictEqual([thrown.calls, thrown.result], [1, "orig:7"]);
    const none = run(undefined);
    assert.deepStrictEqual([none.calls, none.result], [1, "orig:7"]);
    assert.ok(/^[\x00-\x7f]*$/.test(TAIL), "tail is ASCII");
  });

  test("CD3 client/wing.py: ASCII, no tabs, service and notification names, build, wire v1 constants equal to "
    + "the server; no eval/exec of server data; own payload <= 32 KB", () => {
    const text = fs.readFileSync(WING_PY, "utf8");
    assert.ok(/^[\x00-\x7f]*$/.test(text) && !text.includes("\t"));
    for (const needle of [`'${SERVICE_NAME}'`, `'${NOTIFY.STATE}'`, `'${NOTIFY.OPEN}'`, "3396210"]) {
      assert.ok(text.includes(needle), needle);
    }
    const constant = (name) => {
      const m = new RegExp(`^\\s+${name} = (\\d+)$`, "m").exec(text);
      assert.ok(m, `${name} in wing.py`);
      return Number(m[1]);
    };
    assert.strictEqual(constant("PROTO"), REPORT_PROTO);
    assert.strictEqual(constant("WIRE"), WIRE_VERSION);
    assert.strictEqual(SERVICE_WIRE_VERSION, WIRE_VERSION);
    assert.strictEqual(constant("BUILD"), 3396210);
    assert.strictEqual(constant("MAX_VERB_CHARS"), MAX_VERB_CHARS);
    assert.strictEqual(constant("MAX_REPORT_ITEMS"), MAX_REPORT_ITEMS);
    assert.strictEqual(constant("MAX_REPORT_ITEM_CHARS"), MAX_REPORT_ITEM_CHARS);
    assert.ok(!/\beval\(|\bexec\b|\bcompile\(|\bexecfile\(|\binput\(/.test(text), "the client executes no data");
    const payload = buildPayload(text);
    assert.ok(payload.ok && payload.bytes <= MAX_OWN_PAYLOAD_BYTES, String(payload.bytes));
    assert.deepStrictEqual(buildPayload(`caf${String.fromCharCode(0xe9)}`),{ ok: false, reason: "CLIENT_SOURCE" });
    assert.deepStrictEqual(buildPayload(""), { ok: false, reason: "CLIENT_SOURCE" });
  });

  test("CD4 client/wing.py: OnShipWingOpen shows in its own tasklet, fallback eve.Message CustomNotify -> "
    + "gameui Say -> log, the result reported as ui.* (EVENT_PREFIX); handler errors reported, never dispose; "
    + "every `ui.` key passes the server report item check", () => {
    const text = fs.readFileSync(WING_PY, "utf8");
    const method = (name) => {
      const at = text.indexOf(`        def ${name}(`);
      assert.ok(at >= 0, name);
      const next = text.indexOf("\n        def ", at + 1);
      return text.slice(at, next < 0 ? undefined : next);
    };
    const open = method("OnShipWingOpen");
    assert.ok(open.includes("_sw_uthread.new(self.open_window, snapshot, self.generation, items)"), "own tasklet");
    const openWindow = method("open_window");
    assert.ok(openWindow.indexOf("self.window.open(snapshot, items)") >= 0
      && openWindow.indexOf("self.notice(snapshot, generation, items)")
        > openWindow.indexOf("self.window.open(snapshot, items)"),
      "window first, then the W1 notice");
    assert.ok(!open.includes("self.fail(") && open.includes("self.handler_error('open', error)"));
    const notice = method("notice");
    const order = ["show('CustomNotify', {'notify': text})", "GetService('gameui')", "say(text)",
      "_sw_item('ui.open', None if shown else 'NotShown')"].map((n) => notice.indexOf(n));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `fallback order ${order}`);
    const show = method("show_open");
    assert.ok(show.indexOf("self.notice(snapshot, generation, items)") >= 0
      && show.indexOf("self.report(items)") > show.indexOf("self.notice(snapshot, generation, items)"), "notice alone");
    for (const name of ["OnShipWingState", "OnSessionChanged"]) {
      const body = method(name);
      assert.ok(body.includes("self.handler_error(") && !body.includes("self.fail("), `${name}: no dispose`);
    }
    assert.ok(!method("handler_error").includes("self.dispose()"), "handler_error keeps listening");
    assert.ok(method("fail").includes("self.report(") && method("fail").includes("self.dispose()"));
    assert.ok(method("report").includes("_sw_uthread.new(send)"), "the report RPC never blocks a handler");
    const keys = [...text.matchAll(/_sw_item\('(ui\.[a-z.]*)'(?: \+ (\w+))?/g)].map((m) => m[1]);
    assert.ok(keys.length >= 6, keys.join());
    for (const key of keys) {
      assert.ok(key.startsWith(EVENT_PREFIX), key);
      assert.notStrictEqual(parseReportItem(`${key}x=0:TypeError`), null, key);
    }
  });

  test("CD5 compile guard: STUB_SOURCE has try/except and the COMPILE line, ASCII, no "
    + "tabs, no Py3-only forms; the expression compiles the stub, the payload is the data `_sw_b` (inflate = "
    + "wing.py) and never part of the stub text; buffer 0x74, length, original unchanged", () => {
    for (const needle of ["try:\n", "except Exception:\n", "print(\"SHIPWING_UI:UNAVAILABLE:COMPILE\")", "_sw_b",
      "_sw_g)", `"${CODE_NAME}"`]) {
      assert.ok(STUB_SOURCE.includes(needle), needle);
    }
    assert.ok(/^[\x00-\x7f]*$/.test(STUB_SOURCE) && !STUB_SOURCE.includes("\t") && !STUB_SOURCE.includes("'"));
    for (const banned of [/\bf["']/, /\bnonlocal\b/, /:=/, /\bprint [^(]/, /\byield from\b/, /\basync\b/]) {
      assert.ok(!banned.test(STUB_SOURCE), String(banned));
    }
    const { payload, delivery } = ready();
    const expr = "1";
    const original = marshaled(expr);
    const copy = Buffer.from(original);
    const out = delivery.compose(original);
    assert.deepStrictEqual(original, copy, "the original buffer is not changed");
    assert.deepStrictEqual([out[0], out.readUInt32LE(1)], [0x74, out.length - 5]);
    const text = out.toString("latin1", 5);
    assert.ok(/^[\x00-\x7f]*$/.test(text));
    const stubLiteral = `'${STUB_SOURCE.replace(/\n/g, "\\n")}'`;
    assert.ok(text.startsWith(`(lambda _sw_r: (eval(compile(${stubLiteral}, '${STUB_NAME}', 'exec'), `), text.slice(0, 80));
    assert.ok(text.includes(`'_sw_b': '${payload.encoded}'`), "payload as data");
    assert.ok(text.includes("'_sw_g': {'__builtins__': __builtins__, '_sw_context': globals()}"));
    assert.ok(!stubLiteral.includes(payload.encoded) && !STUB_SOURCE.includes(payload.encoded));
    assert.strictEqual(zlib.inflateSync(Buffer.from(payload.encoded, "base64")).toString("ascii"),
      fs.readFileSync(WING_PY, "utf8"));
    assert.ok(text.endsWith(`, _sw_r)[1])(${expr})`));
    assert.strictEqual(payload.bytes, out.length - 5 - expr.length, "buildPayload counts the new head");
  });

  const wingText = () => fs.readFileSync(WING_PY, "utf8");
  const table = (text, name) => {
    const at = text.indexOf(`    ${name} = (`);
    assert.ok(at >= 0, name);
    const end = text.indexOf("\n    )", at);
    assert.ok(end > at, `${name} end`);
    return [...text.slice(at, end).matchAll(/\(('[^()]*')\)/g)]
      .map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]));
  };
  const classBlock = (text, name) => {
    const at = text.indexOf(`    class ${name}(`);
    assert.ok(at >= 0, name);
    const rest = text.slice(at + 1);
    const m = /\n {0,4}\S/.exec(rest);
    return text.slice(at, m ? at + 1 + m.index : undefined);
  };

  test("CD6 wing.py constants and tables: WIRE = WIRE_VERSION, window / button tables have a `carbon` row and "
    + "are never only `eve`, scroll table, a label for every ALL_VERBS verb, window id and caption", () => {
    const { ALL_VERBS } = require("../../lib/core/reasons");
    const text = wingText();
    assert.strictEqual(Number(/^ {4}WIRE = (\d+)$/m.exec(text)[1]), WIRE_VERSION);
    assert.ok(text.includes("    WINDOW_ID = 'shipWingWindow2'") && text.includes("    CAPTION = 'Ship Wing'"));
    for (const name of ["_SW_WINDOW_CLASSES", "_SW_BUTTON_CLASSES"]) {
      const rows = table(text, name);
      assert.ok(rows.length >= 2, name);
      assert.ok(rows.every((r) => r.length === 3), name);
      assert.ok(rows.some((r) => r[0] === "carbon" && r[1].startsWith("carbonui.")), `${name} carbon row`);
      assert.ok(rows.some((r) => r[0] !== "eve"), `${name} not only eve`);
      assert.strictEqual(rows[rows.length - 1][0], "carbon", `${name}: carbon is the last fallback`);
    }
    assert.deepStrictEqual(table(text, "_SW_SCROLL_CLASSES"),
      [["carbon", "carbonui.control.scrollContainer", "ScrollContainer"]]);
    const labels = /_SW_VERB_LABELS = \{([^}]*)\}/.exec(text);
    assert.ok(labels, "_SW_VERB_LABELS");
    const keys = [...labels[1].matchAll(/'(\w+)': '([^']+)'/g)].map((m) => m[1]);
    for (const verb of ALL_VERBS) assert.ok(keys.includes(verb), `label for ${verb}`);
    assert.ok(/'hold': 'Follow'/.test(labels[1]), "Follow = hold");
    assert.ok(/^ {4}_SW_MAX_REPORTED = 64$/m.test(text));
  });

  test("CD7 reports: every 'ui.*' literal of wing.py passes parseReportItem with =1 and =0:Exception; the "
    + "window keys are all there; probe keys (modules, services, attributes, owners) pass and fit MAX_REPORT_ITEMS", () => {
    const text = wingText();
    const literals = [...new Set([...text.matchAll(/'(ui\.[A-Za-z0-9_.]*)'/g)].map((m) => m[1]))];
    for (const key of ["ui.win", "ui.win.class.", "ui.win.parent.", "ui.wire", "ui.render", "ui.hp", "ui.poll",
      "ui.cmd", "ui.target", "ui.close", "ui.select"]) {
      assert.ok(literals.includes(key), key);
    }
    for (const key of literals) {
      assert.ok(key.startsWith(EVENT_PREFIX), key);
      for (const tail of ["=1", "=0:Exception", "=0:header.AttributeError"]) {
        assert.notStrictEqual(parseReportItem(`${key}x${tail}`), null, key + tail);
      }
    }
    const probe = [];
    for (const name of ["_SW_PROBE_MODULES", "_SW_PROBE_SERVICES", "_SW_PROBE_ATTRS"]) {
      for (const row of table(text, name)) probe.push(row[0]);
    }
    for (const key of ["scrollcont.carbon", "attr.win.Open", "attr.win.GetIfOpen", "attr.win.CloseByID",
      "attr.cont.Flush", "attr.checkbox.GetValue", "svc.michelle.GetBallpark", "svc.target.GetActiveTargetID"]) {
      assert.ok(probe.includes(key), key);
    }
    probe.push("dcb", "moon");
    assert.ok(probe.length <= MAX_REPORT_ITEMS, String(probe.length));
    for (const key of probe) {
      assert.ok(!key.startsWith(EVENT_PREFIX), `probe ${key} is not an event`);
      assert.notStrictEqual(parseReportItem(`${key}=0:ImportError`.slice(0, MAX_REPORT_ITEM_CHARS)), null, key);
    }
  });

  test("CD8 wing.py safety and syntax: no eval/exec/compile, RPC only GetState/Command/SetDrones/Report "
    + "no Py3-only forms, ASCII, no tabs, no dispose() in _ShipWingWindow, top-level guard (DELIVERY)", () => {
    const text = wingText();
    assert.ok(/^[\x00-\x7f]*$/.test(text) && !text.includes("\t"));
    assert.ok(!/\beval\(|\bexec\b|\bcompile\(/.test(text), "no eval / exec / compile");
    const rpc = [...text.matchAll(/RemoteSvc\(SVC\)\.(\w+)/g), ...text.matchAll(/\bsvc\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(rpc.length >= 4, rpc.join());
    for (const name of rpc) {
      assert.ok(["GetState", "Command", "SetDrones", "SetEngage", "SetFormation", "Report", "GetCargo", "MoveCargo"]
        .includes(name), name);
    }
    assert.ok(text.includes("RemoteSvc(SVC).GetCargo()") && text.includes("RemoteSvc(SVC).MoveCargo([item_id], target, "
      + "None, None)"), "the window sends GetCargo and MoveCargo");
    assert.ok(text.includes("RemoteSvc(SVC).SetFormation(code)"), "the window sends SetFormation");
    assert.ok(/generation = self\.generation\n\s+self\.formation_ok = True\n\s+self\.combo_ok = True/.test(text),
      "open() shows the Formation row (and tries the list) again");
    assert.ok(text.includes("RemoteSvc(SVC).Command("), "the window sends Command");
    assert.ok(text.includes("RemoteSvc(SVC).SetDrones(list(ids), mode)"), "the window sends SetDrones");
    assert.ok(text.includes("RemoteSvc(SVC).SetEngage(list(ids), mode)"), "the window sends SetEngage");
    assert.ok(/self\.ballpark_ok = True\n\s+self\.drones_ok = True/.test(text), "open() shows the drone buttons again");
    assert.ok(/self\.drones_ok = True\n\s+self\.engage_ok = True\n\s+self\.step = 'open'/.test(text),
      "open() shows the F buttons again");
    for (const banned of [/\bf["']/, /\bnonlocal\b/, /:=/, /\byield from\b/, /\basync /, /\bprint [^(]/,
      /\bbasestring\b/, /\bunicode\(/, /\bprint\([^)]*,[^)]*\)\s*$/m]) {
      assert.ok(!banned.test(text), String(banned));
    }
    const win = classBlock(text, "_ShipWingWindow");
    assert.ok(win.length > 1000, "window class found");
    assert.ok(!win.includes("dispose()"), "the window never disposes the client code");
    assert.ok(win.includes("lambda *a"), "callbacks ignore the control arguments");
    const code = text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    assert.strictEqual(code[0], "try:");
    assert.deepStrictEqual(code.slice(-2), ["except Exception:", "    print('SHIPWING_UI:UNAVAILABLE:DELIVERY')"]);
    const readme = fs.readFileSync(path.resolve(__dirname, "..", "..", "README.md"), "utf8");
    const row = readme.split("\n").find((l) => l.startsWith("| `SHIPWING_UI:UNAVAILABLE:COMPILE`"));
    assert.ok(row && row.includes("SHIPWING_UI:UNAVAILABLE:DELIVERY"), "README COMPILE row names DELIVERY");
  });

  test("CD9 size: own part of the expression < 40 KB; compose with a 200 KB original -> header "
    + "length, < 256 KB", () => {
    const { payload, delivery } = ready();
    assert.ok(payload.bytes < 40 * 1024, String(payload.bytes));
    const original = marshaled(`(${"1".repeat(200 * 1024)})`);
    const out = delivery.compose(original);
    assert.notStrictEqual(out, original, "composed, not skipped");
    assert.deepStrictEqual([out[0], out.readUInt32LE(1)], [0x74, out.length - 5]);
    assert.ok(out.length < MAX_SIGNED_FUNC_BYTES, String(out.length));
    assert.strictEqual(out.length - 5, payload.bytes + original.length - 5);
  });

  test("CD10 one report per window action: open_window reports once, the "
    + "window reports only through emit (collect during open); old command keeps busy; rebuild only on a layout "
    + "change; an unregistered live window is closed", () => {
    const text = wingText();
    const method = (name) => {
      const at = text.indexOf(`        def ${name}(`);
      assert.ok(at >= 0, name);
      const next = text.indexOf("\n        def ", at + 1);
      return text.slice(at, next < 0 ? undefined : next);
    };
    const count = (body, needle) => body.split(needle).length - 1;
    const openWindow = method("open_window");
    assert.strictEqual(count(openWindow, "self.report("), 1, "open_window reports once");
    assert.ok(openWindow.trimEnd().endsWith("self.report(items)"), "the report is the last step");
    assert.ok(method("OnShipWingOpen").includes("self.take_state(snapshot, items)"), "ui.wire joins the open report");
    const win = classBlock(text, "_ShipWingWindow");
    assert.strictEqual(count(win, "owner.report("), 1, "the window reports only through emit");
    assert.ok(method("emit").includes("self.collect.extend(items)") && method("emit").includes("self.owner.report("));
    const openBody = method("open");
    assert.ok(openBody.indexOf("self.collect = items") < openBody.indexOf("self.close('reopen')")
      && /finally:\n\s+self\.collect = None/.test(openBody), "collect set before reopen, cleared in finally");
    for (const name of ["open", "build", "add_select", "close", "ballpark", "live_hp"]) {
      assert.ok(!method(name).includes("owner.report("), `${name} reports through emit`);
    }
    const command = method("command");
    assert.ok(/if generation == self\.generation:\n\s+self\.busy = False/.test(command), "busy under generation");
    assert.ok(!/^ {12}self\.busy = False$/m.test(command), "no unconditional busy = False");
    assert.ok(method("poll").includes("self.state_changed(before)") && !method("poll").includes("request_render"));
    assert.ok(method("OnShipWingState").includes("window.state_changed(previous)"));
    assert.ok(!method("layout").includes("'hp'") && method("state_changed").includes("self.request_render()"));
    assert.ok(/if gone:[\s\S]*win\.Close\(\)/.test(method("player_closed")), "player_closed closes it");
  });

  test("CD11 wing.py: the wait needs only sm and session (no charid); "
    + "run registers the handlers before the first connect and connects only with a character; every dispose() in "
    + "run has a SHIPWING_UI: print before it; a command sends at most ui.maxShips ships and names the rest", () => {
    const text = wingText();
    const method = (name) => {
      const at = text.indexOf(`        def ${name}(`);
      assert.ok(at >= 0, name);
      const next = text.indexOf("\n        def ", at + 1);
      return text.slice(at, next < 0 ? undefined : next);
    };
    const run = method("run");
    const waitName = /if not self\.(wait_\w+)\(\)/.exec(run);
    assert.ok(waitName, "run waits");
    const wait = method(waitName[1]);
    assert.ok(!wait.includes("charid"), "the wait does not need a character");
    assert.ok(wait.includes("self.lookup('sm')") && wait.includes("self.lookup('session')"));
    const register = run.indexOf("RegisterForNotifyEvent");
    const connect = run.indexOf("self.connect(");
    assert.ok(register > 0 && connect > register, "handlers before the first connect");
    assert.ok(/if self\.character:\s*\n\s+self\.connect\(self\.generation\)/.test(run),
      "connect only with a character; else OnSessionChanged connects");
    assert.ok(/if character:\s*\n\s+_sw_uthread\.new\(self\.connect, self\.generation\)/
      .test(method("OnSessionChanged")), "OnSessionChanged connects when the character comes");
    const lines = run.split("\n");
    let disposes = 0;
    lines.forEach((line, i) => {
      if (line.trim() !== "self.dispose()") return;
      disposes += 1;
      assert.ok(/^\s*print\('SHIPWING_UI:/.test(lines[i - 1]), `print before dispose: ${lines[i - 1]}`);
    });
    assert.ok(disposes >= 2, String(disposes));
    assert.ok(run.includes("print('SHIPWING_UI:UNAVAILABLE:WAIT')"));
    const click = method("click");
    assert.ok(click.includes("self.ui_value(self.owner.state, 'maxShips', 0)"), "cap from the ui block");
    assert.ok(/wanted = wanted\[:cap\]/.test(click), "at most cap ships");
    const command = method("command");
    assert.ok(/self\.take_result\(result\)\s*\n\s+if rest > 0:/.test(command), "the rest note after the result");
    assert.ok(text.includes("'%d more not sent'"), "note text");
  });

  test("CD12 (compact window) wing.py: default width 420-480, min <= default; every refusal, client "
    + "refusal, task, state and verb has short words; bar and row lines take the height of their tallest control; "
    + "the header does not repeat the caption; the reason label is refreshed", () => {
    const { REFUSAL, CLIENT_REFUSAL, TASK, ALL_VERBS } = require("../../lib/core/reasons");
    const { STATES } = require("../../lib/core/states");
    const text = wingText();
    const method = (name) => {
      const at = text.indexOf(`        def ${name}(`);
      assert.ok(at >= 0, name);
      const next = text.indexOf("\n        def ", at + 1);
      return text.slice(at, next < 0 ? undefined : next);
    };
    const pair = (name) => {
      const m = new RegExp(`^ {4}${name} = \\((\\d+), (\\d+)\\)$`, "m").exec(text);
      assert.ok(m, name);
      return [Number(m[1]), Number(m[2])];
    };
    const [width, height] = pair("_SW_DEFAULT_SIZE");
    const [minWidth, minHeight] = pair("_SW_MIN_SIZE");
    assert.ok(width >= 420 && width <= 480 && minWidth <= width && minHeight <= height, `${width} ${minWidth}`);
    const keysOf = (name) => {
      const at = text.indexOf(`    ${name} = {`);
      assert.ok(at >= 0, name);
      const body = text.slice(at, text.indexOf("}", at));
      return [...body.matchAll(/'(\w+)': '[^']+'/g)].map((m) => m[1]);
    };
    const reasons = keysOf("_SW_REASON_TEXT");
    for (const code of [...REFUSAL, ...CLIENT_REFUSAL]) assert.ok(reasons.includes(code), `reason ${code}`);
    for (const code of TASK) assert.ok(keysOf("_SW_TASK_TEXT").includes(code), `task ${code}`);
    for (const code of [...STATES, "IN_BAY"]) assert.ok(keysOf("_SW_STATE_TEXT").includes(code), `state ${code}`);
    for (const verb of ALL_VERBS) assert.ok(keysOf("_SW_ROW_VERB_LABELS").includes(verb), `row label ${verb}`);
    const valuesOf = (name) => {
      const at = text.indexOf(`    ${name} = {`);
      return Object.fromEntries([...text.slice(at, text.indexOf("}", at)).matchAll(/'([\w.]+)': '([^']+)'/g)]
        .map((m) => [m[1], m[2]]));
    };
    const short = { ...valuesOf("_SW_ROW_VERB_LABELS"), ...valuesOf("_SW_DRONE_LABELS"),
      ...valuesOf("_SW_CARGO_BAR_LABELS") };
    for (const [key, label] of Object.entries(short)) assert.ok(label.length <= 4, `${key} -> ${label} short`);
    assert.deepStrictEqual(valuesOf("_SW_ROW_VERB_LABELS"), { launch: "Go", return: "Bk", hold: "Fol", mine: "Mn",
      attack: "Atk", salvage: "Slv", board: "Brd" });
    const hintKeys = Object.keys(valuesOf("_SW_BUTTON_HINTS"));
    for (const verb of ALL_VERBS) assert.ok(hintKeys.includes(verb), `hint ${verb}`);
    assert.strictEqual(valuesOf("_SW_VERB_LABELS").return, "Return", "notes keep the full words");
    const build = method("build");
    assert.ok(/self\.fit\(bar, group, _SW_BUTTON_HEIGHT\)/.test(build), "group bar fits its buttons");
    assert.ok(/^ {4}_SW_BAR_MAX_BUTTONS = 8$/m.test(text), "_SW_BAR_MAX_BUTTONS = 8");
    const lines = build.indexOf("_sw_bar_lines(main, toggles, _SW_BAR_MAX_BUTTONS)");
    assert.ok(lines > 0 && build.indexOf("self.fit(bar, group, _SW_BUTTON_HEIGHT)") > lines, "lines, then fit");
    assert.ok(/self\.fit\(low, buttons, _SW_LINE_HEIGHT\)/.test(build), "row line 2 fits its buttons");
    assert.ok(/self\.fit\(top, \[select\], _SW_LINE_HEIGHT\)/.test(build),
      "row line 1 fits the select control only (F moved to line 2)");
    assert.ok(/row\.height = line1 \+ high/.test(build), "row = both lines");
    assert.ok(method("fit").includes("cont.height = height"));
    assert.ok(!method("header_text").includes("Ship Wing"), "No caption in the header");
    assert.ok(method("refresh_rows").includes("self.reason_of(ship)"), "Reason label refreshed");
    assert.ok(method("reason_of").includes("_SW_REASON_TEXT"), "Words, not codes");
  });

  const python = () => {
    for (const cmd of ["python3", "python", "py"]) {
      const r = spawnSync(cmd, ["-I", "-c", "import sys; print(sys.version_info[0])"],
        { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (!r.error && r.status === 0 && /^[23]\s*$/.test(r.stdout)) return cmd;
    }
    return null;
  };

  test("CD13 wing.py HP colours: marks 90/50 by default, red tested before orange with `<`, colour "
    + "markup per number and prefix plain, hp_marks from ui.hpWarnPct/hpCriticalPct with a 1..99 critical < warn "
    + "check, fallback = plain text + one ui.hp; run: 69/70, 39/40, 0, 100, 1000 per mille", () => {
    const text = wingText();
    const constant = (name) => {
      const m = new RegExp(`^ {4}${name} = (.+)$`, "m").exec(text);
      assert.ok(m, name);
      return m[1];
    };
    assert.deepStrictEqual(["_SW_HP_WARN_PCT", "_SW_HP_CRITICAL_PCT", "_SW_HP_WARN_COLOR", "_SW_HP_CRITICAL_COLOR"]
      .map(constant), ["90", "50", "'0xFFFF9900'", "'0xFFFF3333'"]);
    const block = (name, indent) => {
      const at = text.indexOf(`\n${" ".repeat(indent)}def ${name}(`);
      assert.ok(at >= 0, name);
      const m = new RegExp(`\\n {0,${indent}}\\S`).exec(text.slice(at + 1));
      return text.slice(at + 1, at + 1 + m.index);
    };
    const fn = (name) => block(name, 4);
    const method = (name) => block(name, 8);
    const color = fn("_sw_hp_color");
    const red = color.indexOf("if pct < marks[1]:");
    const orange = color.indexOf("if pct < marks[0]:");
    assert.ok(red > 0 && orange > red, "red before orange, strict <");
    assert.ok(method("hp_marks").includes("1 <= critical < warn <= 99"));
    assert.ok(method("hp_marks").includes("'hpWarnPct', _SW_HP_WARN_PCT)")
      && method("hp_marks").includes("'hpCriticalPct', _SW_HP_CRITICAL_PCT)"), "defaults when the field is missing");
    assert.ok(method("server_hp").includes("_sw_hp_text(values, self.hp_marks())"));
    assert.ok(method("live_hp").includes("_sw_hp_text(values, self.hp_marks())"));
    const plain = method("hp_plain");
    assert.ok(plain.includes("self.hp_color = False") && plain.includes("_sw_item('ui.hp', _sw_error_name(error))"));
    assert.ok(method("refresh_rows").includes("text = self.hp_plain(error, text)"), "refresh fallback");
    assert.ok(method("build").includes("text = self.hp_plain(error, text)"), "build fallback");
    assert.ok(/self\.hp_color = True\n\s+self\.hp_live = True/.test(method("open")), "open() tries colours again");

    const cmd = python();
    if (!cmd) return;
    const consts = ["_SW_HP_WARN_PCT", "_SW_HP_CRITICAL_PCT", "_SW_HP_WARN_COLOR", "_SW_HP_CRITICAL_COLOR",
      "_SW_HP_COLOR_END"].map((n) => `${n} = ${constant(n)}`);
    const dedent = (lines, n) => lines.split("\n").map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
      .join("\n");
    const source = [...consts, dedent(fn("_sw_hp_color"), 4), dedent(fn("_sw_hp_text"), 4), dedent(fn("_sw_plain"), 4),
      "class W(object):", dedent(method("ui_value"), 4), dedent(method("hp_marks"), 4),
      "class O(object):", "    pass",
      "import json, sys",
      "def marks(ui, on=True):",
      "    w = W(); w.owner = O(); w.owner.state = {'ui': ui} if ui is not None else {}; w.hp_color = on",
      "    m = w.hp_marks()",
      "    return list(m) if m else None",
      "R, Y = _SW_HP_CRITICAL_COLOR, _SW_HP_WARN_COLOR",
      "out = {",
      " 'c': [_sw_hp_color(p, (70, 40)) for p in (0, 39, 40, 69, 70, 100)],",
      " 'eq': _sw_hp_color(30, (50, 40)),",
      " 't': _sw_hp_text([699, 395, 1000], (70, 40)),",
      " 'p': _sw_plain(_sw_hp_text([699, 395, 1000], (70, 40))),",
      " 'n': _sw_hp_text([0, 400, 700]),",
      " 'm': [marks(None), marks({}), marks({'hpWarnPct': 80, 'hpCriticalPct': 30}),",
      "       marks({'hpWarnPct': 50, 'hpCriticalPct': 50}), marks({'hpWarnPct': 0, 'hpCriticalPct': 0}),",
      "       marks({'hpWarnPct': 100, 'hpCriticalPct': 40}), marks({'hpWarnPct': 80}, False)],",
      "}",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(cmd, ["-I", "-"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const R = "0xFFFF3333";
    const Y = "0xFFFF9900";
    assert.deepStrictEqual(out.c, [R, R, Y, Y, null, null], "0, 39 red; 40, 69 orange; 70, 100 plain");
    assert.strictEqual(out.eq, R, "below both marks: red wins over orange");
    assert.strictEqual(out.t, `S/A/H <color=${Y}>69</color>/<color=${R}>39</color>/100`);
    assert.strictEqual(out.p, "S/A/H 69/39/100");
    assert.strictEqual(out.n, "S/A/H 0/40/70", "no marks = no colour");
    assert.deepStrictEqual(out.m, [[90, 50], [90, 50], [80, 30], [90, 50], [90, 50], [90, 50], null]);
  });

  test("CD14 wing.py button colours: a palette key for every verb and the Dr/F/All roles, 7 base "
    + "colours apart, off dimmer than on; build makes every button through add_button; open() and layout() know "
    + "the switch; run: label markup, button_color on/off/fallback, add_button falls back once, a plain error goes on",
  () => {
    const { ALL_VERBS } = require("../../lib/core/reasons");
    const text = wingText();
    const block = (name, indent) => {
      const at = text.indexOf(`\n${" ".repeat(indent)}def ${name}(`);
      assert.ok(at >= 0, name);
      const m = new RegExp(`\\n {0,${indent}}\\S`).exec(text.slice(at + 1));
      return text.slice(at + 1, at + 1 + m.index);
    };
    const fn = (name) => block(name, 4);
    const method = (name) => block(name, 8);
    const at = text.indexOf("    _SW_BUTTON_COLORS = {");
    assert.ok(at >= 0, "_SW_BUTTON_COLORS");
    const palette = text.slice(at, text.indexOf("\n    }", at) + 6);
    const colors = Object.fromEntries([...palette.matchAll(/'([\w.]+)': (None|'[^']*')/g)].map((m) => [m[1], m[2]]));
    const roles = [...ALL_VERBS, "all", "drones", "drones.auto", "drones.off", "engage", "engage.on", "engage.off"];
    assert.deepStrictEqual(Object.keys(colors).sort(), [...roles].sort());
    for (const [role, value] of Object.entries(colors)) {
      assert.ok(value === "None" || /^'0xFF[0-9A-F]{6}'$/.test(value), `${role} ${value}`);
    }
    const base = ["launch", "return", "hold", "mine", "attack", "drones", "engage"].map((r) => colors[r]);
    assert.strictEqual(new Set(base).size, 7, `7 base colours apart: ${base}`);
    assert.ok(!base.includes("None"));
    assert.notStrictEqual(colors["drones.off"], colors["drones.auto"]);
    assert.notStrictEqual(colors["engage.off"], colors["engage.on"]);
    assert.ok(/self\.btn_color = True\n\s+self\.hp_color = True/.test(method("open")), "open() tries colours again");
    const build = method("build");
    assert.ok(!build.includes("self.place(button") && !build.includes("button(parent"), "no plain button in build");
    assert.strictEqual(build.split("self.add_button(").length - 1, 2, "2 add_button calls");
    assert.ok(method("layout").includes("self.button_colors_on(s)"), "layout knows the switch");

    const cmd = python();
    if (!cmd) return;
    const dedent = (lines, n) => lines.split("\n").map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
      .join("\n");
    const hintsAt = text.indexOf("    _SW_BUTTON_HINTS = {");
    assert.ok(hintsAt >= 0, "_SW_BUTTON_HINTS");
    const hints = text.slice(hintsAt, text.indexOf("\n    }", hintsAt) + 6);
    const source = ["MAX_REPORT_ITEM_CHARS = 96", "_SW_HP_COLOR_END = '</color>'", dedent(palette, 4), dedent(hints, 4),
      dedent(fn("_sw_item"), 4), dedent(fn("_sw_error_name"), 4), dedent(fn("_sw_button_label"), 4),
      "class W(object):", dedent(method("place"), 4), dedent(method("emit"), 4), dedent(method("button_colors_on"), 4),
      dedent(method("button_color"), 4), dedent(method("add_button"), 4), dedent(method("with_hint"), 4),
      "class O(object):", "    pass",
      "class Colorless(object):",
      "    def __init__(self, **kw):",
      "        if '<color' in kw.get('label', ''):",
      "            raise ValueError()",
      "        self.label = kw.get('label')",
      "class Broken(object):",
      "    def __init__(self, **kw):",
      "        raise RuntimeError()",
      "class NoHint(object):",
      "    def __init__(self, **kw):",
      "        object.__setattr__(self, 'label', kw.get('label'))",
      "    def __setattr__(self, name, value):",
      "        raise AttributeError(name)",
      "import json, sys",
      "def win(state, on=True):",
      "    w = W(); w.owner = O(); w.owner.state = state; w.btn_color = on; w.collect = []",
      "    return w",
      "w = win({'ui': {}})",
      "made = w.add_button(Colorless, {'padLeft': 4}, 'Go', 'launch', parent=None)",
      "first = made.label",
      "second = w.add_button(Colorless, {'padLeft': 4}, 'Bk', 'return', parent=None).label",
      "plain = win({'ui': {}}, False)",
      "nohint = plain.add_button(NoHint, {}, 'Bk', 'return', parent=None)",
      "unknown = plain.add_button(Colorless, {}, 'warp', 'warp', parent=None)",
      "hinted = [made.hint, plain.add_button(Colorless, {}, 'D:A', 'drones.auto', parent=None).hint,",
      "          nohint.label, getattr(nohint, 'hint', None), getattr(unknown, 'hint', None), plain.collect]",
      "try:",
      "    win({'ui': {}}).add_button(Broken, {}, 'Go', 'launch')",
      "    broken = 'none'",
      "except Exception as error:",
      "    broken = type(error).__name__",
      "out = {",
      " 'l': [_sw_button_label('Go', '0xFF55DD55'), _sw_button_label('Go', None), _sw_button_label('Go', '')],",
      " 'c': [win({'ui': {}}).button_color('launch'), win({'ui': {'buttonColors': False}}).button_color('launch'),",
      "       win({'ui': {}}, False).button_color('launch'), win({}).button_color('attack'),",
      "       win({'ui': {}}).button_color('all'), win({'ui': {}}).button_color('warp')],",
      " 'fb': [first, second, w.btn_color, w.collect],",
      " 'broken': broken,",
      " 'hint': hinted,",
      "}",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(cmd, ["-I", "-"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.l, ["<color=0xFF55DD55>Go</color>", "Go", "Go"]);
    assert.deepStrictEqual(out.c, ["0xFF55DD55", null, null, "0xFFFF4444", null, null],
      "on / server off / fallback off / no ui field = on / All none / unknown verb none");
    assert.deepStrictEqual(out.fb, ["Go", "Bk", false, ["ui.btncolor=0:ValueError"]], "one fallback item");
    assert.strictEqual(out.broken, "RuntimeError", "a plain button error goes on to the caller");
    assert.deepStrictEqual(out.hint, ["Launch", "Drones auto", "Bk", null, null, []],
      "hint by role; a control refusing the hint keeps its label, no hint, no report; unknown role = no hint");
  });

  test("CD15 wing.py group bar lines: _sw_bar_lines is a module function; run: 8 buttons = one "
    + "line (flag off), 7 + Dr/F = two lines, no toggles = one line, 10 + Dr = [8, 2 + Dr], cap 0 = cap 1", () => {
    const text = wingText();
    const at = text.indexOf("\n    def _sw_bar_lines(main, toggles, cap):");
    assert.ok(at >= 0, "_sw_bar_lines at indent 4");
    const m = /\n {0,4}\S/.exec(text.slice(at + 1));
    const fn = text.slice(at + 1, at + 1 + m.index);
    const cmd = python();
    if (!cmd) return;
    const dedent = (lines, n) => lines.split("\n").map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
      .join("\n");
    const source = [dedent(fn, 4), "import json, sys",
      "V = ['A', 'g', 'b', 'm', 'f', 'x']",
      "out = [_sw_bar_lines(V, ['D', 'F'], 8), _sw_bar_lines(V + ['s'], ['D', 'F'], 8),",
      "       _sw_bar_lines(V + ['s'], [], 8), _sw_bar_lines(['A'] + [str(i) for i in range(9)], ['D'], 8),",
      "       _sw_bar_lines(['A', 'g'], ['D'], 0)]",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(cmd, ["-I", "-"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const nine = ["0", "1", "2", "3", "4", "5", "6", "7", "8"];
    assert.deepStrictEqual(JSON.parse(r.stdout), [
      [["A", "g", "b", "m", "f", "x", "D", "F"]],
      [["A", "g", "b", "m", "f", "x", "s"], ["D", "F"]],
      [["A", "g", "b", "m", "f", "x", "s"]],
      [["A", ...nine.slice(0, 7)], [...nine.slice(7), "D"]],
      [["A"], ["g"], ["D"]],
    ]);
  });

  test("CD16 wing.py window layout: Formation and Cargo on the last bar line "
    + "(next to Dr/F, else one shared line), no bar row of their own; row line 1 without buttons; row line 2 = S/A/H "
    + "in a fixed clipping box, then F, Dr, verbs right to left in a clipping box; run: _sw_tools_line", () => {
    const text = wingText();
    const block = (name, indent) => {
      const at = text.indexOf(`\n${" ".repeat(indent)}def ${name}(`);
      assert.ok(at >= 0, name);
      const m = new RegExp(`\\n {0,${indent}}\\S`).exec(text.slice(at + 1));
      return text.slice(at + 1, at + 1 + m.index);
    };
    const method = (name) => block(name, 8);
    assert.ok(/^ {4}_SW_HP_WIDTH = \d+$/m.test(text), "_SW_HP_WIDTH");
    const build = method("build");
    const order = (labels, body) => {
      let last = -1;
      for (const needle of labels) {
        const at = body.indexOf(needle, last + 1);
        assert.ok(at > last, `order: ${needle}`);
        last = at;
      }
    };
    order(["lines = _sw_bar_lines(main, toggles, _SW_BAR_MAX_BUTTONS)",
      "lines = _sw_tools_line(lines, toggles, formation is not None or cargo_on)",
      "for index, specs in enumerate(lines):", "last = index == len(lines) - 1",
      "if last and formation is not None:", "group += self.add_formation(bar, formation, bool(specs))",
      "if last and cargo_on:", "group += self.add_cargo_bar(bar, bool(specs) or formation is not None)",
      "self.fit(bar, group, _SW_BUTTON_HEIGHT)", "self.step = 'rows'"], build);
    const formation = method("add_formation");
    assert.ok(!formation.includes("parent=self.body") && formation.includes("parent=row, text='Formation:'"));
    assert.ok(/self\.formation_ok = False[\s\S]*control\.Close\(\)[\s\S]*return \[\]/.test(formation),
      "a Formation error closes only its own controls, the bar line lives");
    const cargo = method("add_cargo_bar");
    assert.ok(cargo.includes("parent=row, label=text, func=lambda *a, **k: cargo.toggle()"), "Cargo on the bar");
    assert.ok(!cargo.includes("parent=self.body"), "no Cargo row of its own");
    assert.ok(/self\.owner\.cargo\.cargo_ok = False[\s\S]*return \[\]/.test(cargo), "a Cargo error = no button");
    const rows = build.slice(build.indexOf("for ship in ships:"));
    const line1 = rows.slice(rows.indexOf("top = cont("), rows.indexOf("low = cont("));
    assert.ok(!line1.includes("add_button") && !line1.includes("_SW_ENGAGE_LABELS"), "no F on line 1");
    order(["low = cont(", "hp_box = self.place(cont, clip, parent=low, align=const.TOLEFT, width=_SW_HP_WIDTH)",
      "button_box = self.place(cont, clip, parent=low, align=const.TOALL)", "if engage is not None:",
      "_SW_ENGAGE_LABELS[engage]", "if drones is not None:", "_SW_DRONE_LABELS[drones.get('mode')]",
      "for verb in reversed(self.row_verbs(ship)):", "parent=button_box", "align=const.TORIGHT)",
      "self.fit(low, buttons, _SW_LINE_HEIGHT)", "parent=hp_box"], rows);

    const cmd = python();
    if (!cmd) return;
    const dedent = (lines, n) => lines.split("\n").map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
      .join("\n");
    const source = [dedent(block("_sw_bar_lines", 4), 4), dedent(block("_sw_tools_line", 4), 4), "import json, sys",
      "V = ['A', 'g', 'b', 'm', 'f', 'x', 's']",
      "def t(main, toggles, tools):",
      "    return _sw_tools_line(_sw_bar_lines(main, toggles, 8), toggles, tools)",
      "out = [t(V, ['D', 'F'], True), t(V, ['D', 'F'], False), t(V[:6], ['D', 'F'], True), t(V, [], True),",
      "       t(V, [], False)]",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(cmd, ["-I", "-"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const V = ["A", "g", "b", "m", "f", "x", "s"];
    assert.deepStrictEqual(JSON.parse(r.stdout), [
      [V, ["D", "F"]],
      [V, ["D", "F"]],
      [[...V.slice(0, 6), "D", "F"], []],
      [V, []],
      [V],
    ], "Dr/F line takes the tools; toggles on the verb line or none = one shared new line; no tools = as before");
  });

  test("CD17 wing.py Cargo window: own class, id and caption, the holds moved "
    + "out of Ship Wing; dispose / session / state close it; run (fake UI): bar line 2 = Dr F Formation: combo Cargo, "
    + "row line 1 no button, line 2 S/A/H box then F Dr verbs; Cargo opens its window + one GetCargo, Move = "
    + "MoveCargo + GetCargo, cargo off closes it, a GetCargo error closes it and leaves Ship Wing open", () => {
    const text = wingText();
    const constant = (name) => new RegExp(`^ {4}${name} = (.+)$`, "m").exec(text)[1];
    assert.strictEqual(constant("CARGO_WINDOW_ID"), "'shipWingCargoWindow1'");
    assert.strictEqual(constant("CARGO_CAPTION"), "'Ship Wing Cargo'");
    const wing = classBlock(text, "_ShipWingWindow");
    const cargoWin = classBlock(text, "_ShipWingCargoWindow");
    assert.ok(cargoWin.startsWith("    class _ShipWingCargoWindow(_ShipWingWindow):"));
    assert.ok(cargoWin.includes("window_id = CARGO_WINDOW_ID") && cargoWin.includes("caption = CARGO_CAPTION"));
    for (const moved of ["RemoteSvc(SVC).GetCargo", "RemoteSvc(SVC).MoveCargo", "def add_cargo_rows(",
      "def fetch_cargo("]) {
      assert.ok(!wing.includes(moved) && cargoWin.includes(moved), `${moved} only in the Cargo window`);
    }
    assert.ok(!/windowID=WINDOW_ID/.test(wing), "the window id comes from the class field");
    assert.ok(!cargoWin.includes("dispose()"), "the Cargo window never disposes the client code");
    const client = classBlock(text, "_ShipWingClient");
    const method = (body, name) => {
      const at = body.indexOf(`        def ${name}(`);
      assert.ok(at >= 0, name);
      const next = body.indexOf("\n        def ", at + 1);
      return body.slice(at, next < 0 ? undefined : next);
    };
    assert.ok(method(client, "dispose").includes("self.close_cargo('dispose')"));
    assert.ok(method(client, "OnSessionChanged").includes("self.close_cargo('session')"));
    assert.ok(method(client, "OnShipWingState").includes("self.cargo_state(previous)"));
    assert.ok(method(wing, "poll").includes("self.owner.cargo_state(before)"));
    assert.ok(/try:\n\s+self\.cargo\.close\(where\)\n\s+except Exception:/.test(method(client, "close_cargo")));
    assert.ok(/try:\n\s+self\.cargo\.state_changed\(previous\)\n\s+except Exception as error:/
      .test(method(client, "cargo_state")));

    const cmd = python();
    if (!cmd) return;
    const dedent = (lines, n) => lines.split("\n").map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
      .join("\n");
    const start = text.indexOf("\n    PROTO = 1\n");
    const end = text.indexOf("\n    _sw_previous = getattr(");
    assert.ok(start > 0 && end > start, "client body");
    const source = [
      "import sys, types, json, re, time as _sw_time",
      "_sw_builtins = types.ModuleType('b')",
      "Q = []",
      "class U(object):",
      "    def new(self, f, *a):",
      "        Q.append((f, a))",
      "_sw_uthread = U()",
      "_sw_blue = None",
      "def drain():",
      "    while Q:",
      "        f, a = Q.pop(0)",
      "        if getattr(f, '__name__', '') != 'loop':",
      "            f(*a)",
      "m = types.ModuleType('swfake')",
      "class Ctl(object):",
      "    def __init__(self, **kw):",
      "        self.kw = kw; self.children = []; self.closed = False; self.height = kw.get('height', 0)",
      "        if kw.get('parent') is not None:",
      "            kw['parent'].children.append(self)",
      "    def Close(self):",
      "        self.closed = True",
      "    def Flush(self):",
      "        self.children = []",
      "class Window(Ctl):",
      "    opened = {}",
      "    @classmethod",
      "    def Open(cls, **kw):",
      "        w = cls(**kw); w.content = Ctl(); cls.opened[kw['windowID']] = w",
      "        return w",
      "    @classmethod",
      "    def GetIfOpen(cls, windowID=None):",
      "        w = cls.opened.get(windowID)",
      "        return w if w is not None and not w.closed else None",
      "for name in ('Window', 'Container', 'Button', 'Label', 'Combo', 'Checkbox', 'ScrollContainer'):",
      "    setattr(m, name, Window if name == 'Window' else Ctl)",
      "m.TOTOP, m.TOLEFT, m.TORIGHT, m.TOALL = 'top', 'left', 'right', 'all'",
      "sys.modules['swfake'] = m",
      "_sw_context = {}",
      dedent(text.slice(start + 1, end), 4),
      "for table in ('_SW_WINDOW_CLASSES', '_SW_BUTTON_CLASSES', '_SW_SCROLL_CLASSES', '_SW_CONT_CLASSES',",
      "              '_SW_LABEL_CLASSES', '_SW_CHECKBOX_CLASSES', '_SW_COMBO_CLASSES'):",
      "    globals()[table] = tuple(('fake', 'swfake', row[2]) for row in globals()[table])",
      "_SW_LABEL_CLASSES = (('fake', 'swfake', 'Label'),)",
      "_SW_CONST_MODULES = ('swfake',)",
      "calls = []",
      "class Svc(object):",
      "    fail = False",
      "    many = False",
      "    def GetCargo(self):",
      "        calls.append('GetCargo')",
      "        if Svc.fail:",
      "            raise RuntimeError()",
      "        items = [{'itemID': 77, 'name': 'Veld', 'qty': 3, 'm3': 1}]",
      "        items += [{'itemID': 100 + i, 'name': 'Ore', 'qty': 1, 'm3': 1} for i in range(32 if Svc.many else 0)]",
      "        hold = {'kind': 'mining', 'used': 5, 'cap': 10, 'items': items}",
      "        return {'v': WIRE, 'ok': True, 'hostShipID': 1, 'ships': [",
      "            {'shipItemID': 1, 'name': 'Host', 'holds': [{'kind': 'cargo', 'used': 0, 'cap': 9, 'items': []}]},",
      "            {'shipItemID': 2, 'name': 'Barge', 'holds': [hold]}]}",
      "    def MoveCargo(self, *a):",
      "        calls.append(['MoveCargo'] + list(a))",
      "        return {'v': WIRE, 'ok': True, 'movedQty': 3}",
      "    def Report(self, proto, build, items):",
      "        calls.extend(items)",
      "class SM(object):",
      "    def RemoteSvc(self, name):",
      "        return Svc()",
      "    def GetService(self, name):",
      "        raise RuntimeError()",
      "def state(cargo):",
      "    ship = {'shipItemID': 2, 'name': 'Barge', 'state': 'ACTIVE', 'task': 'MINE', 'engage': 'off',",
      "            'verbs': ['return', 'hold', 'mine', 'attack', 'salvage', 'board'], 'hp': [1000, 1000, 1000],",
      "            'drones': {'mode': 'auto', 'out': 0, 'max': 4}}",
      "    return {'v': WIRE, 'deployed': 1, 'limit': 4, 'verbs': ['launch', 'return', 'hold', 'mine', 'attack',",
      "            'salvage'], 'ships': [ship], 'formation': {'current': 'sphere', 'options': ['none', 'sphere']},",
      "            'cargo': cargo, 'ui': {}}",
      "def names(cont):",
      "    out = []",
      "    for c in cont.children:",
      "        t = c.kw.get('label', c.kw.get('text'))",
      "        out.append('combo' if 'options' in c.kw else re.sub('<[^>]*>', '', t) if t is not None else 'box')",
      "    return out",
      "owner = _ShipWingClient({})",
      "owner.sm = SM()",
      "setattr(_sw_builtins, _SW_KEY, owner)",
      "owner.state = state(True)",
      "out = {'open': owner.window.open(owner.state, [])}",
      "drain()",
      "body = owner.window.body",
      "out['bars'] = [names(c) for c in body.children[1:-1]]",
      "row = body.children[-1].children[0]",
      "top, low = row.children",
      "out['top'] = [k for c in top.children for k in c.kw if k == 'func']",
      "out['low'] = [low.children[0].kw.get('align'), low.children[0].kw.get('width'), low.children[1].kw.get('align')]",
      "out['hp'] = names(low.children[0])",
      "out['buttons'] = names(low.children[1])",
      "out['hints'] = [getattr(c, 'hint', None) for c in low.children[1].children]",
      "out['barHints'] = [getattr(c, 'hint', None) for c in body.children[1].children]",
      "def active_state(codes):",
      "    s = state(True)",
      "    s['ui'] = {'activeChars': 24}",
      "    s['ships'][0]['active'] = codes",
      "    return s",
      "w = owner.window",
      "act = active_state(['prop', 'bogus', 'web'])",
      "out['act'] = [w.layout(state(True)) == w.layout(state(True)), w.layout(state(True)) != w.layout(act),",
      "              w.layout(act) != w.layout(active_state(['prop'])), w.active_key(act['ships'][0], act),",
      "              w.active_key(act['ships'][0], state(True)), w.active_chars({'ui': {'activeChars': 60}})]",
      "def cargo_button():",
      "    return [c for c in owner.window.body.children[2].children if 'Crg' in '%s' % c.kw.get('label')][0]",
      "out['crg'] = [cargo_button().kw.get('label'), getattr(cargo_button(), 'hint', None)]",
      "cargo_button().kw['func']()",
      "drain()",
      "cw = Window.opened.get(CARGO_WINDOW_ID)",
      "rpc = lambda: [c for c in calls if c == 'GetCargo' or isinstance(c, list)]",
      "out['cargo'] = [cw is not None and cw.kw.get('caption'), rpc(), cargo_button().kw.get('label')]",
      "def kids():",
      "    return [b for c in owner.cargo.body.children[-1].children for b in c.children]",
      "def heads():",
      "    return [b.kw['label'] for b in kids() if ('%s' % b.kw.get('label')).startswith('[')]",
      "def press(text):",
      "    [b for b in kids() if ('%s' % b.kw.get('label')).startswith(text)][0].kw['func']()",
      "    drain()",
      "def count(text):",
      "    return len([b for b in kids() if b.kw.get('label') == text or b.kw.get('text') == text])",
      "out['fold'] = [heads(), count('Mv')]",
      "press('[+] Barge')",
      "out['fold'] += [heads(), count('Mv')]",
      "out['mvHint'] = [getattr(b, 'hint', None) for b in kids() if b.kw.get('label') == 'Mv']",
      "press('Mv')",
      "out['move'] = rpc()",
      "out['fold'].append(heads())",
      "Svc.many = True",
      "owner.cargo.body.children[1].children[-1].kw['func']()",
      "drain()",
      "out['rows'] = [count('Mv'), count('   ... +3 more'), count('Show all')]",
      "press('Show all')",
      "out['rows'] += [count('Mv'), count('Show all')]",
      "press('[-] Host')",
      "out['rows'].append(heads())",
      "Svc.many = False",
      "owner.OnShipWingState(state(False))",
      "drain()",
      "out['off'] = [cw.closed, owner.cargo.is_open(), names(owner.window.body.children[2])]",
      "owner.OnShipWingState(state(True))",
      "drain()",
      "Svc.fail = True",
      "cargo_button().kw['func']()",
      "drain()",
      "out['fail'] = [owner.cargo.is_open(), owner.window.is_open(), 'ui.cargo=0:RuntimeError' in calls,",
      "               names(owner.window.body.children[2])]",
      "class Clock(object):",
      "    t = 1000.0",
      "    def time(self):",
      "        return Clock.t",
      "sleeps = []",
      "class Sync(object):",
      "    def SleepWallclock(self, ms):",
      "        sleeps.append(ms)",
      "        Clock.t += ms / 1000.0",
      "class Pyos(object):",
      "    synchro = Sync()",
      "class Blue(object):",
      "    pyos = Pyos()",
      "_sw_time = Clock()",
      "_sw_blue = Blue()",
      "builds = []",
      "_build = _ShipWingCargoWindow.build",
      "def _counted(self, s):",
      "    builds.append(1)",
      "    return _build(self, s)",
      "_ShipWingCargoWindow.build = _counted",
      "Svc.fail = False",
      "owner.cargo.cargo_ok = True",
      "owner.cargo.show(owner.generation)",
      "drain()",
      "def since(n, c):",
      "    return [len(rpc()) - c, len(builds) - n]",
      "n0, c0 = len(builds), len(rpc())",
      "Clock.t += 2",
      "owner.OnShipWingState(state(True))",
      "drain()",
      "out['same'] = since(n0, c0) + [owner.cargo.is_open()]",
      "Svc.many = True",
      "Clock.t += 2",
      "owner.OnShipWingState(state(True))",
      "drain()",
      "out['other'] = since(n0, c0)",
      "Clock.t += 0.9",
      "owner.OnShipWingState(state(True))",
      "owner.OnShipWingState(state(True))",
      "out['trail'] = [since(n0, c0)]",
      "drain()",
      "out['trail'] += [since(n0, c0), sleeps, owner.cargo.trailing]",
      "Clock.t += 2",
      "c1 = len(rpc())",
      "owner.cargo.cargo_refresh()",
      "owner.cargo.show(owner.generation)",
      "queued = len([f for f, a in Q if getattr(f, '__name__', '') == 'fetch_cargo'])",
      "drain()",
      "out['reopen'] = [queued, len(rpc()) - c1, owner.cargo.fetching, owner.cargo.is_open()]",
      "sleeps = []",
      "owner.cargo.fetched_at = _sw_now() + 3600000",
      "owner.OnShipWingState(state(True))",
      "drain()",
      "out['clock'] = [sleeps, owner.cargo.trailing]",
      "owner.cargo.cargo_fold[2] = True",
      "owner.cargo.cargo_all.add(2)",
      "out['before'] = [isinstance(owner.cargo.cargo_data, dict), owner.cargo.cargo_to]",
      "class Sess(object):",
      "    charid = 9",
      "owner.session = Sess()",
      "owner.character = 8",
      "owner.OnSessionChanged()",
      "del Q[:]",
      "out['reset'] = [owner.cargo.cargo_data, owner.cargo.cargo_to, owner.cargo.cargo_fold,",
      "                sorted(owner.cargo.cargo_all), owner.cargo.is_open()]",
      "sys.stdout.write(json.dumps(out))",
    ].join("\n");
    const r = spawnSync(cmd, ["-I", "-"], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.open, true);
    assert.deepStrictEqual(out.bars, [["All", "Go", "Bk", "Fol", "Mn", "Atk", "Slv"],
      ["Dr", "F", "Formation:", "combo", "Crg"]], "Formation and Cargo on the Dr/F line");
    assert.deepStrictEqual(out.barHints, ["Select all", "Launch", "Return to bay", "Follow", "Mine", "Attack",
      "Salvage"]);
    assert.deepStrictEqual(out.hints, ["Ignores F", "Drones auto", "Board", "Salvage", "Attack", "Mine", "Follow",
      "Return to bay"]);
    assert.deepStrictEqual(out.act, [true, true, true, "prop web", null, 19]);
    assert.deepStrictEqual(out.crg, ["Crg", "Cargo window"]);
    assert.deepStrictEqual(out.mvHint, ["Move to the target ship"]);
    assert.deepStrictEqual(out.top, [], "row line 1 has no button");
    assert.deepStrictEqual(out.low, ["left", 150, "all"], "S/A/H box of a fixed width, then the button box");
    assert.ok(out.hp[0].startsWith("S/A/H 100/100/100"), out.hp.join());
    assert.deepStrictEqual(out.buttons, ["F:0", "D:A", "Brd", "Slv", "Atk", "Mn", "Fol", "Bk"],
      "right to left: F rightmost, then Dr, then the verbs");
    assert.deepStrictEqual(out.cargo, ["Ship Wing Cargo", ["GetCargo"], "Crg-"], "own window, one GetCargo");
    assert.deepStrictEqual(out.fold, [
      ["[-] Host (0 stacks, 0/9 m3)", "[+] Barge (1 stacks, 5/10 m3)"], 0,
      ["[-] Host (0 stacks, 0/9 m3)", "[-] Barge (1 stacks, 5/10 m3)"], 1,
      ["[-] Host (0 stacks, 0/9 m3)", "[-] Barge (1 stacks, 5/10 m3)"],
    ], "host open, bay ships folded (no stack lines); a fold choice survives Move + GetCargo");
    assert.deepStrictEqual(out.move, ["GetCargo", ["MoveCargo", [77], 1, null, null], "GetCargo"]);
    assert.deepStrictEqual(out.rows, [30, 1, 1, 33, 0,
      ["[+] Host (0 stacks, 0/9 m3)", "[-] Barge (33 stacks, 5/10 m3)"]],
      "30 stack lines + '... +3 more' / Show all; Show all = 33; Refresh keeps the folds");
    assert.deepStrictEqual(out.off, [true, false, ["Dr", "F", "Formation:", "combo"]], "cargo off closes it");
    assert.deepStrictEqual(out.fail, [false, true, true, ["Dr", "F", "Formation:", "combo"]],
      "a GetCargo error: Cargo closed, one ui.cargo, Ship Wing open without the button");
    assert.deepStrictEqual(out.same, [1, 0, true], "a new state, the same GetCargo data = no rebuild");
    assert.deepStrictEqual(out.other, [2, 1], "other GetCargo data = one rebuild");
    assert.deepStrictEqual(out.trail, [[2, 1], [3, 1], [100], false],
      "two states 900 ms after a GetCargo = one GetCargo at the end of the gap, none lost; same data, no rebuild");
    assert.deepStrictEqual(out.reopen, [1, 2, false, true],
      "debt sweep: a reopen during GetCargo = no second one at once; one for the new window after the old");
    assert.deepStrictEqual(out.clock, [[1000], false], "debt sweep: the wait is at most _SW_CARGO_REFETCH_MS");
    assert.deepStrictEqual(out.before, [true, 1]);
    assert.deepStrictEqual(out.reset, [null, 0, {}, [], false],
      "another character: no data, target, folds or show-all of the old one, the window closed");
  });
};
