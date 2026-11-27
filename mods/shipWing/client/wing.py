try:
    import __builtin__ as _sw_builtins
    import uthread as _sw_uthread
    import blue as _sw_blue
    import time as _sw_time

    PROTO = 1
    WIRE = 2
    BUILDS = (3396210, 3724492)
    SVC = 'shipWingSvc'
    NOTIFY_STATE = 'OnShipWingState'
    NOTIFY_OPEN = 'OnShipWingOpen'
    MAX_VERB_CHARS = 16
    MAX_REPORT_ITEMS = 64
    MAX_REPORT_ITEM_CHARS = 96

    _SW_KEY = '_evejs_shipwing_client'
    _SW_WAIT_STEPS = 240
    _SW_WAIT_MS = 500

    WINDOW_ID = 'shipWingWindow2'
    CAPTION = 'Ship Wing'
    CARGO_WINDOW_ID = 'shipWingCargoWindow1'
    CARGO_CAPTION = 'Ship Wing Cargo'
    _SW_CARGO_REFETCH_MS = 1000
    _SW_CARGO_STALE_MS = 30000
    _SW_CARGO_SECTION_ROWS = 30
    _SW_WINDOW_CLASSES = (
        ('eve', 'eve.client.script.ui.control.eveWindow', 'Window'),
        ('carbon', 'carbonui.control.window', 'Window'),
    )
    _SW_BUTTON_CLASSES = (
        ('eve', 'eve.client.script.ui.control.buttons', 'Button'),
        ('carbon', 'carbonui.control.button', 'Button'),
    )
    _SW_SCROLL_CLASSES = (
        ('carbon', 'carbonui.control.scrollContainer', 'ScrollContainer'),
    )
    _SW_CONT_CLASSES = (
        ('carbon', 'carbonui.primitives.container', 'Container'),
    )
    _SW_LABEL_CLASSES = (
        ('eve', 'eve.client.script.ui.control.eveLabel', 'EveLabelSmall'),
        ('carbon', 'carbonui.control.label', 'Label'),
    )
    _SW_CHECKBOX_CLASSES = (
        ('carbon', 'carbonui.control.checkbox', 'Checkbox'),
    )
    _SW_COMBO_CLASSES = (
        ('carbon', 'carbonui.control.combo', 'Combo'),
        ('eve', 'eve.client.script.ui.control.eveCombo', 'Combo'),
    )
    _SW_CONST_MODULES = ('carbonui.uiconst', 'carbonui.const')
    _SW_VERB_LABELS = {'launch': 'Launch', 'return': 'Return', 'hold': 'Follow', 'mine': 'Mine', 'attack': 'Attack',
                       'salvage': 'Salvage', 'board': 'Board'}
    _SW_ROW_VERB_LABELS = {'launch': 'Go', 'return': 'Bk', 'hold': 'Fol', 'mine': 'Mn', 'attack': 'Atk',
                           'salvage': 'Slv', 'board': 'Brd'}
    _SW_TARGET_VERBS = ('attack', 'mine', 'salvage')
    _SW_DRONE_LABELS = {'auto': 'D:A', 'off': 'D:0'}
    _SW_DRONE_BAR_LABEL = 'Dr'
    _SW_ENGAGE_LABELS = {'on': 'F:1', 'off': 'F:0'}
    _SW_ENGAGE_BAR_LABEL = 'F'
    _SW_ACTIVE_LABELS = {'weapons': 'gun', 'drones': 'drn', 'prop': 'prop', 'localRep': 'rep', 'remoteRep': 'rr',
                         'hardeners': 'hard', 'nos': 'nos', 'neut': 'neut', 'web': 'web', 'scram': 'scram',
                         'disrupt': 'disr'}
    _SW_ACTIVE_CHAR_PX = 6
    _SW_ACTIVE_MAX_WIDTH = 120
    _SW_BUTTON_HINTS = {
        'all': 'Select all',
        'launch': 'Launch',
        'return': 'Return to bay',
        'hold': 'Follow',
        'mine': 'Mine',
        'attack': 'Attack',
        'salvage': 'Salvage',
        'board': 'Board',
        'drones': 'Drones auto / off',
        'drones.auto': 'Drones auto',
        'drones.off': 'Drones off',
        'engage': 'Listens to F / ignores F',
        'engage.on': 'Listens to F',
        'engage.off': 'Ignores F',
        'cargo': 'Cargo window',
        'cargo.move': 'Move to the target ship',
    }
    _SW_CARGO_BAR_LABELS = {'closed': 'Crg', 'open': 'Crg-'}
    _SW_CARGO_MOVE_LABEL = 'Mv'
    _SW_BUTTON_COLORS = {
        'all': None,
        'launch': '0xFF55DD55',
        'return': '0xFF5599FF',
        'hold': '0xFFFFFFFF',
        'mine': '0xFFFFDD44',
        'attack': '0xFFFF4444',
        'salvage': '0xFF33DDCC',
        'drones': '0xFFCC88FF',
        'drones.auto': '0xFFCC88FF',
        'drones.off': '0xFF776688',
        'engage': '0xFFFF8822',
        'engage.on': '0xFFFF8822',
        'engage.off': '0xFF886644',
    }
    _SW_FORMATION_LABELS = {'none': 'None', 'wedge': 'Wedge', 'line': 'Line', 'column': 'Column', 'sphere': 'Sphere'}
    _SW_CARGO_KINDS = {'mining': 'mining', 'cargo': 'cargo', 'fleet': 'fleet'}
    _SW_CARGO_CHARS = 34
    _SW_STATE_TEXT = {'IN_BAY': 'In bay', 'LAUNCHING': 'Launching', 'ACTIVE': 'Out', 'RETURNING': 'Returning',
                      'LOST': 'Lost', 'SETTLED': 'Settled'}
    _SW_TASK_TEXT = {'FOLLOW': 'Following', 'HOLD': 'Holding', 'MINE': 'Mining', 'ATTACK': 'Attacking',
                     'SALVAGE': 'Salvaging'}
    _SW_REASON_TEXT = {
        'DISABLED': 'wing off', 'UNSUPPORTED_VERB': 'not available', 'NOT_IN_SPACE': 'you are docked',
        'OWNER_WARPING': 'you are warping', 'NOT_IN_SMB': 'not in bay', 'NOT_OWNER': 'not yours',
        'SHIP_NOT_ASSEMBLED': 'not assembled', 'MISSING_SKILLS': 'missing skills', 'LIMIT': 'limit reached',
        'ALREADY_DEPLOYED': 'already out', 'NOT_DEPLOYED': 'not out', 'SCENE_NOT_LOADED': 'scene not ready',
        'SPAWN_FAILED': 'launch failed', 'STORE_WRITE_FAILED': 'save failed', 'GUARDS_UNAVAILABLE': 'unavailable',
        'COOLDOWN': 'cooldown', 'LOST_UNSETTLED': 'loss pending', 'LOSS_UNAVAILABLE': 'unavailable',
        'NO_MINING_MODULE': 'no mining module', 'NO_MINEABLE': 'no rock', 'TARGET_INVALID': 'bad target',
        'TASK_UNAVAILABLE': 'unavailable', 'DERIVED_GUARD_UNAVAILABLE': 'unavailable', 'NO_WEAPONS': 'no weapons',
        'NO_TARGET': 'no target', 'TARGET_NOT_NPC': 'NPC only', 'TARGET_OUT_OF_RANGE': 'target too far',
        'NO_AMMO': 'no ammo', 'ENDING': 'going back', 'CAP_UNSTABLE': 'cap unstable', 'TICK_UNAVAILABLE': 'unavailable',
        'DRONES_UNAVAILABLE': 'no drones', 'MODE_INVALID': 'bad mode', 'ENGAGE_UNAVAILABLE': 'F off',
        'FORMATION_UNAVAILABLE': 'formations off', 'FORMATION_INVALID': 'bad formation',
        'NO_SALVAGER': 'no salvager', 'NO_WRECK': 'no wreck', 'HOST_EMPTY': 'host empty',
        'NOT_FLYING': 'not flying', 'TWIN_DYING': 'being destroyed', 'TOO_FAR': 'too far',
        'HOST_CHANGED': 'board from its ship', 'ABYSSAL': 'not in Abyssal', 'SHIP_DEATH_PENDING': 'ship dying',
        'HOST_TOO_FAR': 'too far from its ship', 'HOST_GONE': 'its ship is gone', 'LAUNCH_FAILED': 'launch failed',
        'BOARD_FAILED': 'board failed', 'BOARD_ERROR': 'board error', 'SCOPE_INVALID': 'cannot launch here',
        'NO_CHARACTER': 'no character', 'RATE_LIMIT': 'too fast', 'BAD_ARGS': 'bad command',
        'TOO_MANY_SHIPS': 'too many ships', 'SKIPPED': 'skipped', 'INTERNAL': 'server error', 'REFUSED': 'refused',
        'HOST_INVALID': 'your ship?', 'ITEM_NOT_FOUND': 'item gone', 'ITEM_INVALID': 'not movable',
        'SOURCE_INVALID': 'not in a hold', 'FLAG_INVALID': 'no such hold', 'SAME_HOLD': 'already there',
        'TYPE_NOT_ALLOWED': 'no hold takes it', 'NO_ROOM': 'no room', 'QUANTITY_INVALID': 'nothing to move',
        'MOVE_FAILED': 'move failed',
    }
    _SW_MAX_REPORTED = 64
    _SW_DEFAULT_SIZE = (460, 300)
    _SW_MIN_SIZE = (440, 200)
    _SW_LINE_HEIGHT = 20
    _SW_BUTTON_HEIGHT = 26
    _SW_GAP = 6
    _SW_BUTTON_GAP = 4
    _SW_SELECT_WIDTH = 24
    _SW_BAR_MAX_BUTTONS = 8
    _SW_DRONE_TEXT_WIDTH = 56
    _SW_HP_WIDTH = 150
    _SW_FORMATION_WIDTH = 120
    _SW_NAME_CHARS = 30
    _SW_TARGET_CHARS = 18
    _SW_DIM_COLOR = (0.85, 0.7, 0.45, 0.8)
    _SW_MIN_STEP_MS = 250
    _SW_HP_WARN_PCT = 90
    _SW_HP_CRITICAL_PCT = 50
    _SW_HP_WARN_COLOR = '0xFFFF9900'
    _SW_HP_CRITICAL_COLOR = '0xFFFF3333'
    _SW_HP_COLOR_END = '</color>'

    _SW_PROBE_MODULES = (
        ('win.carbon', 'carbonui.control.window', 'Window'),
        ('win.eve', 'eve.client.script.ui.control.eveWindow', 'Window'),
        ('cont.carbon', 'carbonui.primitives.container', 'Container'),
        ('cont.autosize', 'carbonui.primitives.containerAutoSize', 'ContainerAutoSize'),
        ('label.medium', 'eve.client.script.ui.control.eveLabel', 'EveLabelMedium'),
        ('label.small', 'eve.client.script.ui.control.eveLabel', 'EveLabelSmall'),
        ('button.carbon', 'carbonui.control.button', 'Button'),
        ('button.eve', 'eve.client.script.ui.control.buttons', 'Button'),
        ('scroll.eve', 'eve.client.script.ui.control.eveScroll', 'Scroll'),
        ('entry.generic', 'eve.client.script.ui.control.entries.generic', 'Generic'),
        ('checkbox.carbon', 'carbonui.control.checkbox', 'Checkbox'),
        ('scrollcont.carbon', 'carbonui.control.scrollContainer', 'ScrollContainer'),
        ('const.carbon', 'carbonui.uiconst', 'TOTOP'),
        ('combo.carbon', 'carbonui.control.combo', 'Combo'),
        ('combo.eve', 'eve.client.script.ui.control.eveCombo', 'Combo'),
        ('fill.carbon', 'carbonui.primitives.fill', 'Fill'),
        ('button.style', 'carbonui.button.const', 'ButtonStyle'),
        ('button.variant', 'carbonui.button.const', 'ButtonVariant'),
    )
    _SW_PROBE_SERVICES = (
        ('svc.michelle.GetBallpark', 'michelle', 'GetBallpark'),
        ('svc.target.GetActiveTargetID', 'target', 'GetActiveTargetID'),
        ('svc.target.GetTargets', 'target', 'GetTargets'),
        ('svc.stateSvc.GetStates', 'stateSvc', 'GetStates'),
    )
    _SW_PROBE_ATTRS = (
        ('attr.win.Open', 'carbonui.control.window', 'Window', 'Open'),
        ('attr.win.GetIfOpen', 'carbonui.control.window', 'Window', 'GetIfOpen'),
        ('attr.win.CloseByID', 'carbonui.control.window', 'Window', 'CloseByID'),
        ('attr.cont.Flush', 'carbonui.primitives.container', 'Container', 'Flush'),
        ('attr.checkbox.GetValue', 'carbonui.control.checkbox', 'Checkbox', 'GetValue'),
    )

    def _sw_item(key, error):
        if error is None:
            text = key + '=1'
        else:
            text = key + '=0:' + error
        return text[:MAX_REPORT_ITEM_CHARS]

    def _sw_error_name(error):
        try:
            return type(error).__name__
        except Exception:
            return 'Exception'

    def _sw_int(value):
        try:
            return int(value)
        except Exception:
            return 0

    def _sw_now():
        return int(_sw_time.time() * 1000)

    def _sw_frozen(value):
        if isinstance(value, dict):
            return tuple(sorted([('%s' % k, _sw_frozen(v)) for k, v in value.items()], key=lambda kv: kv[0]))
        if isinstance(value, (list, tuple)):
            return tuple([_sw_frozen(v) for v in value])
        return value

    def _sw_pick(candidates):
        for variant, module, attribute in candidates:
            try:
                loaded = __import__(module, fromlist=[attribute])
            except Exception:
                continue
            found = getattr(loaded, attribute, None)
            if found is not None:
                return variant, found
        return None, None

    def _sw_uiconst():
        for module in _SW_CONST_MODULES:
            try:
                loaded = __import__(module, fromlist=['TOTOP'])
            except Exception:
                continue
            if hasattr(loaded, 'TOTOP'):
                return loaded
        raise NoConst()

    def _sw_hp_color(pct, marks):
        if pct < marks[1]:
            return _SW_HP_CRITICAL_COLOR
        if pct < marks[0]:
            return _SW_HP_WARN_COLOR
        return None

    def _sw_hp_text(values, marks=None):
        parts = []
        for value in values[:3]:
            pct = value // 10
            color = _sw_hp_color(pct, marks) if marks else None
            if color:
                parts.append('<color=%s>%d%s' % (color, pct, _SW_HP_COLOR_END))
            else:
                parts.append('%d' % pct)
        return 'S/A/H ' + '/'.join(parts)

    def _sw_plain(text):
        text = text.replace(_SW_HP_COLOR_END, '')
        for color in (_SW_HP_WARN_COLOR, _SW_HP_CRITICAL_COLOR):
            text = text.replace('<color=%s>' % color, '')
        return text

    def _sw_button_label(text, color):
        if not color:
            return text
        return '<color=%s>%s%s' % (color, text, _SW_HP_COLOR_END)

    def _sw_short(text, chars):
        text = '%s' % text
        if len(text) > chars:
            return text[:max(1, chars - 2)] + '..'
        return text

    def _sw_bar_lines(main, toggles, cap):
        cap = max(1, int(cap))
        main = list(main)
        toggles = list(toggles)
        lines = [main[index:index + cap] for index in range(0, len(main), cap)]
        if lines and len(lines[-1]) + len(toggles) <= cap:
            lines[-1] = lines[-1] + toggles
        elif toggles:
            lines.extend([toggles[index:index + cap] for index in range(0, len(toggles), cap)])
        return lines

    def _sw_tools_line(lines, toggles, tools):
        lines = list(lines)
        if tools and not (toggles and lines and lines[-1] == list(toggles)):
            lines.append([])
        return lines

    def _sw_words(code, table):
        code = '%s' % code
        return table.get(code, code.lower().replace('_', ' '))

    class NoClass(Exception):
        pass

    class NoParent(Exception):
        pass

    class NoWindow(Exception):
        pass

    class NoConst(Exception):
        pass

    class _ShipWingWindow(object):
        window_id = WINDOW_ID
        caption = CAPTION

        def __init__(self, owner):
            self.owner = owner
            self.win = None
            self.cls = None
            self.body = None
            self.const = None
            self.header_label = None
            self.rows = {}
            self.selected = set()
            self.reasons = {}
            self.note = ''
            self.step = 'open'
            self.busy = False
            self.render_pending = False
            self.auto_opened = False
            self.generation = 0
            self.hp_live = True
            self.ballpark_ok = True
            self.hp_color = True
            self.btn_color = True
            self.checkbox_ok = True
            self.drones_ok = True
            self.engage_ok = True
            self.formation_ok = True
            self.combo_ok = True
            self.cargo_ok = True
            self.cargo_data = None
            self.cargo_to = 0
            self.classes = {}
            self.collect = None

        def emit(self, items):
            if self.collect is not None:
                self.collect.extend(items)
            else:
                self.owner.report(items)

        def ships(self, snapshot):
            if not isinstance(snapshot, dict):
                return []
            return [ship for ship in (snapshot.get('ships') or ()) if isinstance(ship, dict)]

        def ship_of(self, ship_id):
            for ship in self.ships(self.owner.state):
                if _sw_int(ship.get('shipItemID')) == ship_id:
                    return ship
            return None

        def row_verbs(self, ship):
            if not isinstance(ship, dict):
                return []
            return list(ship.get('verbs') or ())

        def ui_value(self, snapshot, key, default):
            try:
                return int(snapshot.get('ui').get(key))
            except Exception:
                return default

        def verb_label(self, verb, row=False):
            labels = _SW_ROW_VERB_LABELS if row else _SW_VERB_LABELS
            return '%s' % labels.get(verb, verb)

        def header_text(self, snapshot):
            s = snapshot if isinstance(snapshot, dict) else {}
            text = '%d/%d out' % (_sw_int(s.get('deployed')), _sw_int(s.get('limit')))
            if _sw_int(s.get('truncated')) > 0:
                text += ', +%d more' % _sw_int(s.get('truncated'))
            if s.get('refusal'):
                text += ', %s' % _sw_words(s.get('refusal'), _SW_REASON_TEXT)
            if self.note:
                text += ', %s' % self.note
            return text

        def hp_marks(self):
            if not self.hp_color:
                return None
            warn = self.ui_value(self.owner.state, 'hpWarnPct', _SW_HP_WARN_PCT)
            critical = self.ui_value(self.owner.state, 'hpCriticalPct', _SW_HP_CRITICAL_PCT)
            if not (1 <= critical < warn <= 99):
                return (_SW_HP_WARN_PCT, _SW_HP_CRITICAL_PCT)
            return (warn, critical)

        def hp_plain(self, error, text):
            plain = _sw_plain(text)
            if plain == text:
                raise error
            self.hp_color = False
            self.emit([_sw_item('ui.hp', _sw_error_name(error))])
            return plain

        def server_hp(self, ship):
            hp = ship.get('hp')
            if hp is None:
                return ''
            try:
                values = [_sw_int(value) for value in hp]
            except Exception:
                return 'HP ?'
            if len(values) != 3:
                return 'HP ?'
            return _sw_hp_text(values, self.hp_marks()) + '~'

        def reason_of(self, ship):
            entry = self.reasons.get(_sw_int(ship.get('shipItemID')))
            keep = self.ui_value(self.owner.state, 'rowReasonMs', 8000)
            if entry is not None and _sw_now() - entry[1] < keep:
                return _sw_words(entry[0], _SW_REASON_TEXT)
            if ship.get('refusal'):
                return _sw_words(ship.get('refusal'), _SW_REASON_TEXT)
            return ''

        def name_text(self, ship):
            name = '%s' % (ship.get('name') or ship.get('typeName') or '?')
            kind = ship.get('typeName')
            if kind and '%s' % kind != name:
                name = '%s (%s)' % (name, kind)
            return _sw_short(name, _SW_NAME_CHARS)

        def state_text(self, ship):
            state = '%s' % (ship.get('state') or '?')
            if state == 'ACTIVE' and ship.get('task'):
                return _sw_words(ship.get('task'), _SW_TASK_TEXT)
            return _sw_words(state, _SW_STATE_TEXT)

        def drones_of(self, ship):
            if not self.drones_ok or not isinstance(ship, dict) or ship.get('state') != 'ACTIVE':
                return None
            drones = ship.get('drones')
            if not isinstance(drones, dict) or drones.get('mode') not in _SW_DRONE_LABELS:
                return None
            return drones

        def engage_of(self, ship):
            if not self.engage_ok or not isinstance(ship, dict) or ship.get('state') != 'ACTIVE':
                return None
            mode = ship.get('engage')
            return mode if mode in _SW_ENGAGE_LABELS else None

        def active_chars(self, snapshot):
            chars = self.ui_value(snapshot if isinstance(snapshot, dict) else {}, 'activeChars', 0)
            return min(chars, max(0, (_SW_ACTIVE_MAX_WIDTH - _SW_GAP) // _SW_ACTIVE_CHAR_PX))

        def active_of(self, ship, snapshot):
            if not isinstance(ship, dict) or ship.get('state') != 'ACTIVE':
                return None
            codes = ship.get('active')
            if not isinstance(codes, (list, tuple)) or not codes:
                return None
            if self.active_chars(snapshot) <= 0:
                return None
            return codes

        def active_text(self, codes, chars):
            labels = []
            for code in codes:
                try:
                    text = _SW_ACTIVE_LABELS.get('%s' % code)
                except Exception:
                    text = None
                if text and text not in labels:
                    labels.append(text)
            return _sw_short(' '.join(labels), chars) if labels else ''

        def drones_text(self, drones):
            top = drones.get('max')
            return 'dr %d/%s' % (_sw_int(drones.get('out')), '?' if top is None else _sw_int(top))

        def row_text(self, ship, hp_text):
            if hp_text is None:
                hp_text = self.server_hp(ship)
            parts = [hp_text] if hp_text else []
            if ship.get('targetName'):
                parts.append('> %s' % _sw_short(ship.get('targetName'), _SW_TARGET_CHARS))
            return '   '.join(parts)

        def make(self, kind, candidates):
            found = self.classes.get(kind)
            if found is None:
                variant, found = _sw_pick(candidates)
                if found is None:
                    raise NoClass()
                self.classes[kind] = found
            return found

        def set_text(self, label, text):
            try:
                label.text = text
            except Exception:
                label.SetText(text)

        def place(self, cls, extra, **kw):
            if extra:
                try:
                    merged = dict(kw)
                    merged.update(extra)
                    return cls(**merged)
                except Exception:
                    pass
            return cls(**kw)

        def button_colors_on(self, snapshot=None):
            if not self.btn_color:
                return False
            try:
                state = self.owner.state if snapshot is None else snapshot
                return state.get('ui').get('buttonColors') is not False
            except Exception:
                return True

        def button_color(self, role):
            if not self.button_colors_on():
                return None
            return _SW_BUTTON_COLORS.get(role)

        def add_button(self, cls, extra, label, role, **kw):
            color = self.button_color(role)
            hint = _SW_BUTTON_HINTS.get(role)
            if color:
                try:
                    return self.with_hint(self.place(cls, extra, label=_sw_button_label(label, color), **kw), hint)
                except Exception as error:
                    self.btn_color = False
                    self.emit([_sw_item('ui.btncolor', _sw_error_name(error))])
            return self.with_hint(self.place(cls, extra, label=label, **kw), hint)

        def with_hint(self, control, hint):
            if hint:
                try:
                    control.hint = hint
                except Exception:
                    pass
            return control

        def fit(self, cont, controls, floor):
            height = floor
            for control in controls:
                height = max(height, _sw_int(getattr(control, 'height', 0)))
            cont.height = height
            return height

        def handler(self, verb, ids):
            return lambda *a, **k: self.click(verb, ids)

        def group_handler(self, verb):
            return lambda *a, **k: self.click(verb, sorted(self.selected))

        def drones_handler(self, ids):
            return lambda *a, **k: self.drones_click(sorted(self.selected) if ids is None else ids)

        def engage_handler(self, ids):
            return lambda *a, **k: self.engage_click(sorted(self.selected) if ids is None else ids)

        def toggle_handler(self, ship_id, redraw):
            return lambda *a, **k: self.toggle(ship_id, redraw)

        def all_handler(self):
            return lambda *a, **k: self.toggle_all()

        def flush(self, cont):
            flush = getattr(cont, 'Flush', None)
            if flush is not None:
                flush()
                return
            for child in list(getattr(cont, 'children', None) or ()):
                child.Close()

        def find_parent(self, win):
            content = getattr(win, 'content', None)
            if content is not None:
                return content, 'content'
            main_area = getattr(win, 'GetMainArea', None)
            if main_area is not None:
                found = main_area()
                if found is not None:
                    return found, 'main'
            found = getattr(getattr(win, 'sr', None), 'main', None)
            if found is not None:
                return found, 'srmain'
            raise NoParent()

        def create(self, cls):
            if hasattr(cls, 'Open'):
                try:
                    win = cls.Open(windowID=self.window_id, caption=self.caption, minSize=_SW_MIN_SIZE,
                                   width=_SW_DEFAULT_SIZE[0], height=_SW_DEFAULT_SIZE[1])
                except TypeError:
                    win = cls.Open(windowID=self.window_id, caption=self.caption)
                if win is None and hasattr(cls, 'GetIfOpen'):
                    win = cls.GetIfOpen(windowID=self.window_id)
            else:
                win = cls(windowID=self.window_id, caption=self.caption)
            if win is None:
                raise NoWindow()
            return win

        def close_existing(self, cls, items):
            try:
                getter = getattr(cls, 'GetIfOpen', None)
                if getter is not None:
                    old = getter(windowID=self.window_id)
                    if old is not None:
                        old.Close()
            except Exception as error:
                items.append(_sw_item('ui.close', _sw_error_name(error)))

        def open(self, snapshot, items):
            self.collect = items
            try:
                self.close('reopen')
                generation = self.generation
                self.formation_ok = True
                self.combo_ok = True
                self.owner.cargo.cargo_ok = True
                self.btn_color = True
                self.hp_color = True
                self.hp_live = True
                self.ballpark_ok = True
                self.drones_ok = True
                self.engage_ok = True
                self.step = 'open'
                try:
                    variant, cls = _sw_pick(_SW_WINDOW_CLASSES)
                    if cls is None:
                        raise NoClass()
                    items.append(_sw_item('ui.win.class.' + variant, None))
                    self.cls = cls
                    self.close_existing(cls, items)
                    self.win = self.create(cls)
                    self.step = 'parent'
                    parent, where = self.find_parent(self.win)
                    items.append(_sw_item('ui.win.parent.' + where, None))
                    self.const = _sw_uiconst()
                    self.body = self.make('cont', _SW_CONT_CLASSES)(parent=parent, align=self.const.TOALL)
                    self.build(snapshot)
                except Exception as error:
                    items.append(_sw_item('ui.win', '%s.%s' % (self.step, _sw_error_name(error))))
                    self.close('build')
                    return False
                items.append(_sw_item('ui.win', None))
                _sw_uthread.new(self.loop, generation)
                return True
            finally:
                self.collect = None

        def build(self, snapshot):
            self.step = 'header'
            const = self.const
            self.flush(self.body)
            self.rows = {}
            self.header_label = None
            ships = self.ships(snapshot)
            self.selected = self.selected & set([_sw_int(ship.get('shipItemID')) for ship in ships])
            cont = self.make('cont', _SW_CONT_CLASSES)
            button = self.make('button', _SW_BUTTON_CLASSES)
            label = self.make('label', _SW_LABEL_CLASSES)
            clip = {'clipChildren': True}
            header = self.place(cont, clip, parent=self.body, align=const.TOTOP, height=_SW_LINE_HEIGHT)
            self.header_label = label(parent=header, text=self.header_text(snapshot), align=const.TOLEFT)
            gap = {'padRight': _SW_BUTTON_GAP}
            verbs = list(snapshot.get('verbs') or ()) if isinstance(snapshot, dict) else []
            main = [('All', 'all', self.all_handler())]
            main += [(self.verb_label(verb, True), verb, self.group_handler(verb)) for verb in verbs]
            toggles = []
            if [ship for ship in ships if self.drones_of(ship) is not None]:
                toggles.append((_SW_DRONE_BAR_LABEL, 'drones', self.drones_handler(None)))
            if [ship for ship in ships if self.engage_of(ship) is not None]:
                toggles.append((_SW_ENGAGE_BAR_LABEL, 'engage', self.engage_handler(None)))
            lines = _sw_bar_lines(main, toggles, _SW_BAR_MAX_BUTTONS)
            formation = self.formation_of(snapshot) if self.formation_ok else None
            cargo_on = self.owner.cargo.cargo_on(snapshot)
            lines = _sw_tools_line(lines, toggles, formation is not None or cargo_on)
            for index, specs in enumerate(lines):
                extra = {'padTop': _SW_BUTTON_GAP, 'clipChildren': True}
                last = index == len(lines) - 1
                if last:
                    extra['padBottom'] = _SW_GAP
                bar = self.place(cont, extra, parent=self.body, align=const.TOTOP, height=_SW_BUTTON_HEIGHT)
                group = [self.add_button(button, gap, text, role, parent=bar, func=func, align=const.TOLEFT)
                         for text, role, func in specs]
                if last and formation is not None:
                    group += self.add_formation(bar, formation, bool(specs))
                if last and cargo_on:
                    group += self.add_cargo_bar(bar, bool(specs) or formation is not None)
                self.fit(bar, group, _SW_BUTTON_HEIGHT)
            self.step = 'rows'
            holder = self.add_holder()
            ballpark = self.ballpark()
            dim = {'color': _SW_DIM_COLOR, 'padRight': _SW_GAP}
            left = {'padLeft': _SW_SELECT_WIDTH}
            for ship in ships:
                ship_id = _sw_int(ship.get('shipItemID'))
                row = self.place(cont, {'padBottom': _SW_GAP}, parent=holder, align=const.TOTOP,
                                 height=_SW_LINE_HEIGHT + _SW_BUTTON_HEIGHT)
                top = cont(parent=row, align=const.TOTOP, height=_SW_LINE_HEIGHT)
                select = self.add_select(top, ship_id)
                engage = self.engage_of(ship)
                drones = self.drones_of(ship)
                if drones is not None:
                    counter = self.place(cont, clip, parent=top, align=const.TORIGHT, width=_SW_DRONE_TEXT_WIDTH)
                    self.place(label, {'padLeft': _SW_GAP}, parent=counter, text=self.drones_text(drones),
                               align=const.TOLEFT)
                label(parent=top, text=self.state_text(ship), align=const.TORIGHT)
                reason = self.reason_of(ship)
                why = self.place(label, dim, parent=top, text=reason, align=const.TORIGHT)
                codes = self.active_of(ship, self.owner.state)
                if codes is not None:
                    chars = self.active_chars(self.owner.state)
                    running = self.active_text(codes, chars)
                    if running:
                        width = min(len(running), chars) * _SW_ACTIVE_CHAR_PX + _SW_GAP
                        box = self.place(cont, clip, parent=top, align=const.TORIGHT, width=width)
                        self.place(label, {'padLeft': _SW_GAP}, parent=box, text=running, align=const.TOLEFT)
                name_box = self.place(cont, clip, parent=top, align=const.TOALL)
                self.place(label, {'padLeft': _SW_BUTTON_GAP}, parent=name_box, text=self.name_text(ship),
                           align=const.TOLEFT)
                low = cont(parent=row, align=const.TOTOP, height=_SW_LINE_HEIGHT)
                hp_box = self.place(cont, clip, parent=low, align=const.TOLEFT, width=_SW_HP_WIDTH)
                button_box = self.place(cont, clip, parent=low, align=const.TOALL)
                specs = []
                if engage is not None:
                    specs.append((_SW_ENGAGE_LABELS[engage], 'engage.' + engage, self.engage_handler([ship_id])))
                if drones is not None:
                    specs.append((_SW_DRONE_LABELS[drones.get('mode')], 'drones.%s' % drones.get('mode'),
                                  self.drones_handler([ship_id])))
                for verb in reversed(self.row_verbs(ship)):
                    specs.append((self.verb_label(verb, True), verb, self.handler(verb, [ship_id])))
                buttons = [self.add_button(button, {'padLeft': _SW_BUTTON_GAP}, text, role, parent=button_box,
                                           func=func, align=const.TORIGHT) for text, role, func in specs]
                high = self.fit(low, buttons, _SW_LINE_HEIGHT)
                line1 = self.fit(top, [select], _SW_LINE_HEIGHT)
                row.height = line1 + high
                text = self.row_text(ship, self.live_hp(ballpark, _sw_int(ship.get('entityID'))))
                spot = dict(left)
                spot['padTop'] = max(0, (high - _SW_LINE_HEIGHT) // 2)
                try:
                    hp = self.place(label, spot, parent=hp_box, text=text, align=const.TOLEFT)
                except Exception as error:
                    text = self.hp_plain(error, text)
                    hp = self.place(label, spot, parent=hp_box, text=text, align=const.TOLEFT)
                self.rows[ship_id] = [ship, hp, text, why, reason]

        def add_holder(self):
            const = self.const
            scroll_variant, scroll = _sw_pick(_SW_SCROLL_CLASSES)
            if scroll is not None:
                try:
                    return scroll(parent=self.body, align=const.TOALL)
                except Exception:
                    pass
            return self.make('cont', _SW_CONT_CLASSES)(parent=self.body, align=const.TOALL)

        def add_select(self, row, ship_id):
            checked = ship_id in self.selected
            if self.checkbox_ok:
                try:
                    box = self.make('checkbox', _SW_CHECKBOX_CLASSES)
                    return box(parent=row, text='', checked=checked, callback=self.toggle_handler(ship_id, False),
                               align=self.const.TOLEFT, width=_SW_SELECT_WIDTH)
                except Exception as error:
                    self.checkbox_ok = False
                    self.emit([_sw_item('ui.select', _sw_error_name(error))])
            button = self.make('button', _SW_BUTTON_CLASSES)
            return button(parent=row, label='[x]' if checked else '[ ]', func=self.toggle_handler(ship_id, True),
                          align=self.const.TOLEFT)

        def formation_of(self, snapshot):
            if not isinstance(snapshot, dict):
                return None
            field = snapshot.get('formation')
            if not isinstance(field, dict):
                return None
            text = (type(''), type(u''))
            current = field.get('current')
            options = tuple(['%s' % code for code in (field.get('options') or ()) if isinstance(code, text)])
            if not isinstance(current, text) or not options:
                return None
            return ('%s' % current, options)

        def formation_label(self, code):
            return '%s' % _SW_FORMATION_LABELS.get(code, code)

        def add_formation(self, row, formation, after):
            made = []
            try:
                const = self.const
                label = self.make('label', _SW_LABEL_CLASSES)
                spot = {'padRight': _SW_GAP, 'padTop': max(0, (_SW_BUTTON_HEIGHT - _SW_LINE_HEIGHT) // 2)}
                if after:
                    spot['padLeft'] = _SW_GAP
                made.append(self.place(label, spot, parent=row, text='Formation:', align=const.TOLEFT))
                kind = 'combo'
                control = self.add_combo(row, formation)
                if control is None:
                    kind = 'button'
                    button = self.make('button', _SW_BUTTON_CLASSES)
                    control = button(parent=row, label='Form: %s' % self.formation_label(formation[0]),
                                     func=self.formation_cycle_handler(), align=const.TOLEFT)
                made.append(control)
                self.emit([_sw_item('ui.formation.class.' + kind, None)])
                return [control]
            except Exception as error:
                self.formation_ok = False
                self.emit([_sw_item('ui.formation', _sw_error_name(error))])
                for control in made:
                    try:
                        control.Close()
                    except Exception:
                        pass
                return []

        def add_combo(self, row, formation):
            if not self.combo_ok:
                return None
            try:
                combo_cls = self.make('combo', _SW_COMBO_CLASSES)
                made = []
                options = [(self.formation_label(code), code) for code in formation[1]]
                combo = combo_cls(parent=row, options=options, select=formation[0],
                                  callback=lambda *a, **k: self.formation_pick(made, a),
                                  align=self.const.TOLEFT, width=_SW_FORMATION_WIDTH)
                made.append(combo)
                return combo
            except Exception as error:
                self.combo_ok = False
                self.emit([_sw_item('ui.formation.combo', _sw_error_name(error))])
                return None

        def formation_pick(self, made, args):
            try:
                code = None
                getter = getattr(made[0], 'GetValue', None) if made else None
                if getter is not None:
                    code = getter()
                if code is None and args:
                    code = args[-1]
                for known in _SW_FORMATION_LABELS:
                    if code == _SW_FORMATION_LABELS[known]:
                        code = known
                self.formation_click(code)
            except Exception as error:
                self.emit([_sw_item('ui.formation', 'pick.' + _sw_error_name(error))])

        def formation_cycle_handler(self):
            return lambda *a, **k: self.formation_cycle()

        def formation_cycle(self):
            try:
                formation = self.formation_of(self.owner.state)
                if formation is None:
                    return
                current, options = formation
                at = options.index(current) + 1 if current in options else 0
                self.formation_click(options[at % len(options)])
            except Exception as error:
                self.emit([_sw_item('ui.formation', 'cycle.' + _sw_error_name(error))])

        def formation_click(self, code):
            try:
                formation = self.formation_of(self.owner.state)
                if formation is None or not self.formation_ok or code is None:
                    return
                code = '%s' % code
                if code == formation[0] or code not in formation[1]:
                    return
                if self.busy:
                    self.set_note('busy')
                    self.request_render()
                    return
                self.busy = True
                self.set_note('%s...' % self.formation_label(code))
                _sw_uthread.new(self.set_formation, code, self.generation)
            except Exception as error:
                self.busy = False
                self.emit([_sw_item('ui.formation', 'click.' + _sw_error_name(error))])

        def set_formation(self, code, generation):
            try:
                result = self.owner.sm.RemoteSvc(SVC).SetFormation(code)
                if generation == self.generation:
                    if isinstance(result, dict):
                        self.take_formation(result)
                    else:
                        self.formation_ok = False
                        self.note = ''
                        self.emit([_sw_item('ui.formation', 'Absent')])
            except Exception as error:
                if generation == self.generation:
                    self.formation_ok = False
                    self.note = ''
                self.emit([_sw_item('ui.formation', _sw_error_name(error))])
            if generation == self.generation:
                self.busy = False
                self.request_render()

        def take_formation(self, result):
            if result.get('v') != WIRE:
                self.emit([_sw_item('ui.wire', 'Mismatch')])
                return
            if result.get('ok'):
                self.note = 'not saved' if result.get('persisted') is False else ''
            else:
                self.note = _sw_words(result.get('reason') or 'REFUSED', _SW_REASON_TEXT)

        def add_cargo_bar(self, row, after):
            try:
                button = self.make('button', _SW_BUTTON_CLASSES)
                spot = {'padRight': _SW_BUTTON_GAP}
                if after:
                    spot['padLeft'] = _SW_GAP
                cargo = self.owner.cargo
                text = _SW_CARGO_BAR_LABELS['open' if cargo.is_open() else 'closed']
                made = self.place(button, spot, parent=row, label=text, func=lambda *a, **k: cargo.toggle(),
                                  align=self.const.TOLEFT)
                return [self.with_hint(made, _SW_BUTTON_HINTS['cargo'])]
            except Exception as error:
                self.owner.cargo.cargo_ok = False
                self.emit([_sw_item('ui.cargo', 'button.' + _sw_error_name(error))])
                return []

        def is_open(self):
            return self.win is not None

        def alive(self, generation):
            return self.owner.current() and generation == self.generation and self.win is not None

        def player_closed(self):
            win = self.win
            if win is None or getattr(win, 'destroyed', False):
                return True
            getter = getattr(self.cls, 'GetIfOpen', None)
            if getter is None:
                return False
            try:
                gone = getter(windowID=self.window_id) is None
            except Exception:
                return False
            if gone:
                try:
                    win.Close()
                except Exception:
                    pass
            return gone

        def request_render(self):
            if self.render_pending or not self.is_open():
                return
            self.render_pending = True
            _sw_uthread.new(self.render, self.generation)

        def render(self, generation):
            self.render_pending = False
            if not self.alive(generation):
                return
            if self.player_closed():
                self.close('player')
                return
            try:
                self.build(self.owner.state)
            except Exception as error:
                self.emit([_sw_item('ui.render', '%s.%s' % (self.step, _sw_error_name(error)))])
                self.close('render')

        def loop(self, generation):
            waited = 0
            try:
                while self.alive(generation):
                    snapshot = self.owner.state
                    step = max(_SW_MIN_STEP_MS, self.ui_value(snapshot, 'hpRefreshMs', 1000))
                    _sw_blue.pyos.synchro.SleepWallclock(step)
                    if not self.alive(generation):
                        return
                    if self.player_closed():
                        self.close('player')
                        return
                    self.refresh_rows()
                    self.owner.cargo_watch()
                    waited += step
                    poll = self.ui_value(snapshot, 'pollMs', 0)
                    if poll > 0 and waited >= poll:
                        waited = 0
                        self.poll(generation)
            except Exception as error:
                self.emit([_sw_item('ui.render', 'loop.' + _sw_error_name(error))])
                if generation == self.generation:
                    self.close('loop')

        def ballpark(self):
            if not self.hp_live or not self.ballpark_ok:
                return None
            try:
                return self.owner.sm.GetService('michelle').GetBallpark()
            except Exception as error:
                self.emit([_sw_item('ui.hp', _sw_error_name(error))])
                return None

        def live_hp(self, ballpark, entity):
            if ballpark is None or not entity or not self.ballpark_ok:
                return None
            try:
                state = ballpark.GetDamageState(entity)
                if not state:
                    return None
                values = []
                for value in list(state)[:3]:
                    if isinstance(value, (tuple, list)):
                        value = value[0] if value else None
                    if value is None:
                        return None
                    values.append(int(round(max(0.0, min(1.0, float(value))) * 1000)))
                if len(values) != 3:
                    return None
                return _sw_hp_text(values, self.hp_marks())
            except Exception as error:
                if isinstance(error, AttributeError):
                    self.ballpark_ok = False
                self.emit([_sw_item('ui.hp', _sw_error_name(error))])
                return None

        def refresh_rows(self):
            if not self.hp_live:
                return
            try:
                ballpark = self.ballpark()
                for ship_id in list(self.rows.keys()):
                    entry = self.rows[ship_id]
                    ship = entry[0]
                    text = self.row_text(ship, self.live_hp(ballpark, _sw_int(ship.get('entityID'))))
                    if text != entry[2]:
                        try:
                            self.set_text(entry[1], text)
                        except Exception as error:
                            text = self.hp_plain(error, text)
                            self.set_text(entry[1], text)
                        entry[2] = text
                    reason = self.reason_of(ship)
                    if reason != entry[4]:
                        self.set_text(entry[3], reason)
                        entry[4] = reason
            except Exception as error:
                self.hp_live = False
                self.emit([_sw_item('ui.hp', _sw_error_name(error))])

        def poll(self, generation):
            before = self.owner.state
            try:
                state = self.owner.sm.RemoteSvc(SVC).GetState()
            except Exception as error:
                self.emit([_sw_item('ui.poll', _sw_error_name(error))])
                return
            if self.alive(generation) and self.owner.take_state(state):
                self.owner.cargo_state(before)
                self.state_changed(before)

        def layout(self, snapshot):
            s = snapshot if isinstance(snapshot, dict) else {}
            rows = [(_sw_int(ship.get('shipItemID')), ship.get('name'), ship.get('typeName'), ship.get('state'),
                     ship.get('task'), ship.get('targetName'), ship.get('refusal'), tuple(self.row_verbs(ship)),
                     self.drones_key(ship), self.engage_of(ship), self.active_key(ship, s))
                    for ship in self.ships(s)]
            return (s.get('deployed'), s.get('limit'), s.get('truncated'), s.get('refusal'),
                    tuple(s.get('verbs') or ()), rows, self.formation_of(s), self.button_colors_on(s),
                    s.get('cargo') is True)

        def drones_key(self, ship):
            drones = self.drones_of(ship)
            if drones is None:
                return None
            return (drones.get('mode'), self.drones_text(drones))

        def active_key(self, ship, snapshot):
            codes = self.active_of(ship, snapshot)
            if codes is None:
                return None
            return self.active_text(codes, self.active_chars(snapshot))

        def state_changed(self, before):
            if self.layout(before) != self.layout(self.owner.state):
                self.request_render()
                return
            for ship in self.ships(self.owner.state):
                entry = self.rows.get(_sw_int(ship.get('shipItemID')))
                if entry is not None:
                    entry[0] = ship

        def toggle(self, ship_id, redraw):
            try:
                if ship_id in self.selected:
                    self.selected.discard(ship_id)
                else:
                    self.selected.add(ship_id)
                if redraw:
                    self.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.select', _sw_error_name(error))])

        def toggle_all(self):
            try:
                ids = set([_sw_int(ship.get('shipItemID')) for ship in self.ships(self.owner.state)])
                if ids and ids <= self.selected:
                    self.selected = set()
                else:
                    self.selected = ids
                self.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.select', _sw_error_name(error))])

        def set_note(self, note):
            self.note = note
            if self.header_label is not None:
                self.set_text(self.header_label, self.header_text(self.owner.state))

        def click(self, verb, ids):
            try:
                if self.busy:
                    self.set_note('busy')
                    return
                wanted = [ship_id for ship_id in ids if verb in self.row_verbs(self.ship_of(ship_id))]
                if not wanted:
                    self.set_note('nothing to do')
                    return
                cap = self.ui_value(self.owner.state, 'maxShips', 0)
                rest = 0
                if cap > 0 and len(wanted) > cap:
                    rest = len(wanted) - cap
                    wanted = wanted[:cap]
                self.busy = True
                self.set_note('%s...' % self.verb_label(verb))
                _sw_uthread.new(self.command, verb, wanted, self.generation, rest)
            except Exception as error:
                self.busy = False
                self.emit([_sw_item('ui.cmd', _sw_error_name(error))])

        def target_id(self):
            try:
                found = _sw_int(self.owner.sm.GetService('target').GetActiveTargetID())
                return found if found > 0 else None
            except Exception as error:
                self.emit([_sw_item('ui.target', _sw_error_name(error))])
                return None

        def command(self, verb, ids, generation, rest=0):
            try:
                target = None
                if verb in _SW_TARGET_VERBS:
                    target = self.target_id()
                result = self.owner.sm.RemoteSvc(SVC).Command(list(ids), verb, target)
                if generation == self.generation:
                    self.take_result(result)
                    if rest > 0:
                        more = '%d more not sent' % rest
                        self.note = '%s, %s' % (self.note, more) if self.note else more
            except Exception as error:
                self.emit([_sw_item('ui.cmd', _sw_error_name(error))])
            if generation == self.generation:
                self.busy = False
                self.request_render()

        def drones_click(self, ids):
            try:
                if self.busy:
                    self.set_note('busy')
                    return
                wanted = [ship_id for ship_id in ids if self.drones_of(self.ship_of(ship_id)) is not None]
                if not wanted:
                    self.set_note('nothing to do')
                    return
                modes = [self.drones_of(self.ship_of(ship_id)).get('mode') for ship_id in wanted]
                mode = 'off' if 'auto' in modes else 'auto'
                cap = self.ui_value(self.owner.state, 'maxShips', 0)
                rest = 0
                if cap > 0 and len(wanted) > cap:
                    rest = len(wanted) - cap
                    wanted = wanted[:cap]
                self.busy = True
                self.set_note('%s...' % _SW_BUTTON_HINTS['drones.' + mode])
                _sw_uthread.new(self.set_drones, mode, wanted, self.generation, rest)
            except Exception as error:
                self.busy = False
                self.emit([_sw_item('ui.drones', _sw_error_name(error))])

        def set_drones(self, mode, ids, generation, rest=0):
            try:
                result = self.owner.sm.RemoteSvc(SVC).SetDrones(list(ids), mode)
                if generation == self.generation:
                    if isinstance(result, dict):
                        self.take_result(result)
                        if rest > 0:
                            more = '%d more not sent' % rest
                            self.note = '%s, %s' % (self.note, more) if self.note else more
                    else:
                        self.drones_ok = False
                        self.note = ''
                        self.emit([_sw_item('ui.drones', 'Absent')])
            except Exception as error:
                if generation == self.generation:
                    self.drones_ok = False
                    self.note = ''
                self.emit([_sw_item('ui.drones', _sw_error_name(error))])
            if generation == self.generation:
                self.busy = False
                self.request_render()

        def engage_click(self, ids):
            try:
                if self.busy:
                    self.set_note('busy')
                    return
                wanted = [ship_id for ship_id in ids if self.engage_of(self.ship_of(ship_id)) is not None]
                if not wanted:
                    self.set_note('nothing to do')
                    return
                modes = [self.engage_of(self.ship_of(ship_id)) for ship_id in wanted]
                mode = 'off' if 'on' in modes else 'on'
                cap = self.ui_value(self.owner.state, 'maxShips', 0)
                rest = 0
                if cap > 0 and len(wanted) > cap:
                    rest = len(wanted) - cap
                    wanted = wanted[:cap]
                self.busy = True
                self.set_note('%s...' % _SW_BUTTON_HINTS['engage.' + mode])
                _sw_uthread.new(self.set_engage, mode, wanted, self.generation, rest)
            except Exception as error:
                self.busy = False
                self.emit([_sw_item('ui.engage', _sw_error_name(error))])

        def set_engage(self, mode, ids, generation, rest=0):
            try:
                result = self.owner.sm.RemoteSvc(SVC).SetEngage(list(ids), mode)
                if generation == self.generation:
                    if isinstance(result, dict):
                        self.take_result(result)
                        if rest > 0:
                            more = '%d more not sent' % rest
                            self.note = '%s, %s' % (self.note, more) if self.note else more
                    else:
                        self.engage_ok = False
                        self.note = ''
                        self.emit([_sw_item('ui.engage', 'Absent')])
            except Exception as error:
                if generation == self.generation:
                    self.engage_ok = False
                    self.note = ''
                self.emit([_sw_item('ui.engage', _sw_error_name(error))])
            if generation == self.generation:
                self.busy = False
                self.request_render()

        def take_result(self, result):
            if not isinstance(result, dict) or result.get('v') != WIRE:
                self.emit([_sw_item('ui.wire', 'Mismatch')])
                return
            now = _sw_now()
            seen = False
            for entry in result.get('results') or ():
                if not isinstance(entry, dict):
                    continue
                seen = True
                ship_id = _sw_int(entry.get('shipItemID'))
                if entry.get('ok'):
                    self.reasons.pop(ship_id, None)
                else:
                    self.reasons[ship_id] = ('%s' % (entry.get('reason') or 'REFUSED'), now)
            if result.get('ok') is False and not seen:
                self.note = _sw_words(result.get('reason') or 'REFUSED', _SW_REASON_TEXT)
            else:
                self.note = ''

        def close(self, where):
            win = self.win
            cls = self.cls
            self.generation += 1
            self.win = None
            self.body = None
            self.rows = {}
            self.header_label = None
            self.render_pending = False
            self.busy = False
            if win is None or where == 'player':
                return
            try:
                win.Close()
            except Exception as error:
                items = [_sw_item('ui.close', _sw_error_name(error))]
                try:
                    closer = getattr(cls, 'CloseByID', None)
                    if closer is not None:
                        closer(windowID=self.window_id)
                except Exception:
                    pass
                self.emit(items)

    class _ShipWingCargoWindow(_ShipWingWindow):
        window_id = CARGO_WINDOW_ID
        caption = CARGO_CAPTION

        def __init__(self, owner):
            _ShipWingWindow.__init__(self, owner)
            self.fetching = False
            self.fetched_at = 0
            self.fetch_generation = None
            self.cargo_fold = {}
            self.cargo_all = set()
            self.drawn = None
            self.again = False
            self.trailing = False
            self.holder = None
            self.scroll_ok = True

        def forget(self):
            self.cargo_data = None
            self.cargo_to = 0
            self.cargo_fold = {}
            self.cargo_all = set()
            self.note = ''
            self.drawn = None

        def close(self, where):
            _ShipWingWindow.close(self, where)
            self.drawn = None
            self.again = False
            self.trailing = False
            self.holder = None

        def signature(self):
            data = self.cargo_data if isinstance(self.cargo_data, dict) else None
            frozen = None if data is None else _sw_frozen([data.get('ships'), data.get('truncated'),
                                                           data.get('hostShipID')])
            return (frozen, self.cargo_to, tuple(sorted(self.cargo_fold.items())), tuple(sorted(self.cargo_all)))

        def scroll_position(self):
            holder = self.holder
            if holder is None or not self.scroll_ok:
                return None
            try:
                getter = getattr(holder, 'GetPositionVertical', None)
                return getter() if getter is not None else None
            except Exception:
                self.scroll_ok = False
                return None

        def scroll_restore(self, holder, position):
            if position is None or not self.scroll_ok:
                return
            try:
                setter = getattr(holder, 'ScrollToVertical', None)
                if setter is not None:
                    setter(position)
            except Exception:
                self.scroll_ok = False

        def hook_close(self, win, generation):
            callback = lambda *a, **k: self.closed_by_player(generation)
            try:
                signal = getattr(win, 'on_close', None)
                if signal is not None and hasattr(signal, 'connect'):
                    signal.connect(callback)
                    return True
                for name in ('OnClose', '_OnClose'):
                    original = getattr(win, name, None)
                    if callable(original):
                        setattr(win, name, self.close_wrapper(original, callback))
                        return True
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'hook.' + _sw_error_name(error))])
            return False

        def close_wrapper(self, original, callback):
            def wrapped(*a, **k):
                try:
                    return original(*a, **k)
                finally:
                    try:
                        callback()
                    except Exception:
                        pass
            return wrapped

        def closed_by_player(self, generation):
            if generation != self.generation or self.win is None:
                return
            self.close('player')
            self.owner.window.request_render()

        def watch(self):
            if self.is_open() and self.player_closed():
                self.close('player')
                self.owner.window.request_render()

        def cargo_on(self, snapshot):
            return isinstance(snapshot, dict) and snapshot.get('cargo') is True and self.cargo_ok

        def header_text(self, snapshot):
            return self.note or 'Holds of your ship and its bay'

        def toggle(self):
            try:
                if self.is_open() and not self.player_closed():
                    self.close('toggle')
                else:
                    self.close('player')
                    _sw_uthread.new(self.show, self.owner.generation)
                self.owner.window.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'toggle.' + _sw_error_name(error))])

        def show(self, owner_generation):
            items = []
            self.collect = items
            try:
                try:
                    if not self.owner.current() or owner_generation != self.owner.generation:
                        return
                    if not self.cargo_on(self.owner.state):
                        return
                    self.close('reopen')
                    self.note = ''
                    elapsed = _sw_now() - self.fetched_at
                    if elapsed < 0 or elapsed > _SW_CARGO_STALE_MS:
                        self.fetching = False
                    self.step = 'open'
                    variant, cls = _sw_pick(_SW_WINDOW_CLASSES)
                    if cls is None:
                        raise NoClass()
                    self.cls = cls
                    self.close_existing(cls, items)
                    self.win = self.create(cls)
                    self.hook_close(self.win, self.generation)
                    self.step = 'parent'
                    parent, where = self.find_parent(self.win)
                    self.const = _sw_uiconst()
                    self.body = self.make('cont', _SW_CONT_CLASSES)(parent=parent, align=self.const.TOALL)
                    self.build(self.owner.state)
                    items.append(_sw_item('ui.cargo.win', None))
                    self.cargo_refresh()
                except Exception as error:
                    items.append(_sw_item('ui.cargo.win', '%s.%s' % (self.step, _sw_error_name(error))))
                    self.close('build')
            finally:
                self.collect = None
            self.emit(items)
            self.owner.window.request_render()

        def build(self, snapshot):
            self.step = 'header'
            const = self.const
            position = self.scroll_position()
            self.holder = None
            self.flush(self.body)
            self.header_label = None
            cont = self.make('cont', _SW_CONT_CLASSES)
            button = self.make('button', _SW_BUTTON_CLASSES)
            label = self.make('label', _SW_LABEL_CLASSES)
            header = self.place(cont, {'clipChildren': True}, parent=self.body, align=const.TOTOP,
                                height=_SW_LINE_HEIGHT)
            self.header_label = label(parent=header, text=self.header_text(snapshot), align=const.TOLEFT)
            specs = [('Refresh', lambda *a, **k: self.cargo_refresh())]
            if self.cargo_ships():
                specs.insert(0, ('To: %s' % self.cargo_name(self.cargo_to), lambda *a, **k: self.cargo_cycle()))
            line = self.place(cont, {'padTop': _SW_BUTTON_GAP, 'padBottom': _SW_GAP, 'clipChildren': True},
                              parent=self.body, align=const.TOTOP, height=_SW_BUTTON_HEIGHT)
            made = [self.place(button, {'padRight': _SW_BUTTON_GAP}, parent=line, label=text, func=func,
                               align=const.TOLEFT) for text, func in specs]
            self.fit(line, made, _SW_BUTTON_HEIGHT)
            self.step = 'rows'
            holder = self.add_holder()
            if isinstance(self.cargo_data, dict):
                self.add_cargo_rows(holder)
            else:
                label(parent=holder, text='loading...', align=const.TOTOP)
            self.holder = holder
            self.scroll_restore(holder, position)
            self.drawn = self.signature()

        def render(self, generation):
            self.render_pending = False
            if not self.alive(generation):
                return
            if self.player_closed():
                self.close('player')
                self.owner.window.request_render()
                return
            try:
                if self.cargo_ok and self.drawn is not None and self.drawn == self.signature():
                    self.set_note(self.note)
                    return
                self.build(self.owner.state)
                if not self.cargo_ok:
                    self.close('rows')
                    self.owner.window.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.cargo.render', '%s.%s' % (self.step, _sw_error_name(error)))])
                self.close('render')
                self.owner.window.request_render()

        def state_changed(self, before):
            if not self.is_open():
                return
            if not self.cargo_on(self.owner.state):
                self.close('off')
                self.owner.window.request_render()
                return
            if self.player_closed():
                self.close('player')
                self.owner.window.request_render()
                return
            gap = min(_SW_CARGO_REFETCH_MS - (_sw_now() - self.fetched_at), _SW_CARGO_REFETCH_MS)
            if gap <= 0:
                self.cargo_refresh()
            elif not self.trailing:
                self.trailing = True
                _sw_uthread.new(self.trail, self.generation, gap)

        def trail(self, generation, wait):
            try:
                _sw_blue.pyos.synchro.SleepWallclock(wait)
            except Exception:
                pass
            if generation != self.generation:
                return
            self.trailing = False
            self.cargo_refresh()

        def cargo_ships(self):
            data = self.cargo_data if isinstance(self.cargo_data, dict) else {}
            return [ship for ship in (data.get('ships') or ()) if isinstance(ship, dict)]

        def cargo_name(self, ship_id):
            for ship in self.cargo_ships():
                if _sw_int(ship.get('shipItemID')) == ship_id:
                    return _sw_short(ship.get('name') or '?', _SW_TARGET_CHARS)
            return '?'

        def ship_holds(self, ship):
            return [hold for hold in (ship.get('holds') or ()) if isinstance(hold, dict)]

        def section_text(self, ship, open_):
            holds = self.ship_holds(ship)
            text = '%s %s' % ('[-]' if open_ else '[+]', _sw_short(ship.get('name') or '?', _SW_NAME_CHARS))
            if holds:
                stacks = sum([len([i for i in (hold.get('items') or ()) if isinstance(i, dict)]) for hold in holds])
                used = sum([_sw_int(hold.get('used')) for hold in holds])
                cap = sum([_sw_int(hold.get('cap')) for hold in holds])
                text += ' (%d stacks, %d/%d m3)' % (stacks, used, cap)
            return text

        def section_open(self, ship_id):
            if ship_id in self.cargo_fold:
                return self.cargo_fold[ship_id]
            return ship_id == _sw_int((self.cargo_data or {}).get('hostShipID'))

        def section_handler(self, ship_id):
            return lambda *a, **k: self.section_toggle(ship_id)

        def all_rows_handler(self, ship_id):
            return lambda *a, **k: self.section_all(ship_id)

        def section_toggle(self, ship_id):
            try:
                self.cargo_fold[ship_id] = not self.section_open(ship_id)
                self.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'fold.' + _sw_error_name(error))])

        def section_all(self, ship_id):
            try:
                self.cargo_all.add(ship_id)
                self.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'all.' + _sw_error_name(error))])

        def forget_gone(self):
            ids = set([_sw_int(ship.get('shipItemID')) for ship in self.cargo_ships()])
            for ship_id in list(self.cargo_fold.keys()):
                if ship_id not in ids:
                    del self.cargo_fold[ship_id]
            self.cargo_all = self.cargo_all & ids

        def add_cargo_rows(self, holder):
            try:
                const = self.const
                cont = self.make('cont', _SW_CONT_CLASSES)
                button = self.make('button', _SW_BUTTON_CLASSES)
                label = self.make('label', _SW_LABEL_CLASSES)
                more = _sw_int(self.cargo_data.get('truncated'))
                if more > 0:
                    label(parent=holder, text='+%d more stacks' % more, align=const.TOTOP)
                for ship in self.cargo_ships():
                    ship_id = _sw_int(ship.get('shipItemID'))
                    open_ = self.section_open(ship_id)
                    head = self.place(cont, {'padTop': _SW_BUTTON_GAP, 'clipChildren': True}, parent=holder,
                                      align=const.TOTOP, height=_SW_BUTTON_HEIGHT)
                    toggle = self.place(button, None, parent=head, label=self.section_text(ship, open_),
                                        func=self.section_handler(ship_id), align=const.TOLEFT)
                    self.fit(head, [toggle], _SW_BUTTON_HEIGHT)
                    if not open_:
                        continue
                    cap = None if ship_id in self.cargo_all else _SW_CARGO_SECTION_ROWS
                    shown = 0
                    hidden = 0
                    for hold in self.ship_holds(ship):
                        items = [item for item in (hold.get('items') or ()) if isinstance(item, dict)]
                        if cap is not None and shown >= cap:
                            hidden += len(items)
                            continue
                        kind = _SW_CARGO_KINDS.get(hold.get('kind'), '%s' % hold.get('kind'))
                        label(parent=holder, text='  %s %d/%d m3' % (kind, _sw_int(hold.get('used')),
                                                                     _sw_int(hold.get('cap'))), align=const.TOTOP)
                        for item in items:
                            if cap is not None and shown >= cap:
                                hidden += 1
                                continue
                            shown += 1
                            line = self.place(cont, {'clipChildren': True}, parent=holder, align=const.TOTOP,
                                              height=_SW_LINE_HEIGHT)
                            made = []
                            if ship_id != self.cargo_to:
                                func = self.cargo_handler(_sw_int(item.get('itemID')))
                                made.append(self.with_hint(self.place(button, {'padLeft': _SW_BUTTON_GAP},
                                                                      parent=line, label=_SW_CARGO_MOVE_LABEL,
                                                                      func=func, align=const.TORIGHT),
                                                           _SW_BUTTON_HINTS['cargo.move']))
                            text = '   %s x%d (%d m3)' % (_sw_short(item.get('name') or '?', _SW_CARGO_CHARS),
                                                         _sw_int(item.get('qty')), _sw_int(item.get('m3')))
                            label(parent=line, text=text, align=const.TOLEFT)
                            self.fit(line, made, _SW_LINE_HEIGHT)
                    if hidden > 0:
                        line = self.place(cont, {'clipChildren': True}, parent=holder, align=const.TOTOP,
                                          height=_SW_LINE_HEIGHT)
                        made = [self.place(button, {'padLeft': _SW_BUTTON_GAP}, parent=line, label='Show all',
                                           func=self.all_rows_handler(ship_id), align=const.TORIGHT)]
                        label(parent=line, text='   ... +%d more' % hidden, align=const.TOLEFT)
                        self.fit(line, made, _SW_LINE_HEIGHT)
            except Exception as error:
                self.cargo_ok = False
                self.emit([_sw_item('ui.cargo', 'rows.' + _sw_error_name(error))])

        def cargo_handler(self, item_id):
            return lambda *a, **k: self.cargo_move(item_id)

        def cargo_refresh(self):
            if not self.is_open():
                return
            if self.fetching:
                self.again = True
                return
            self.fetching = True
            self.fetched_at = _sw_now()
            self.fetch_generation = self.generation
            _sw_uthread.new(self.fetch_cargo, self.generation)

        def cargo_cycle(self):
            try:
                ids = [_sw_int(ship.get('shipItemID')) for ship in self.cargo_ships()]
                if ids:
                    at = ids.index(self.cargo_to) + 1 if self.cargo_to in ids else 0
                    self.cargo_to = ids[at % len(ids)]
                self.request_render()
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'cycle.' + _sw_error_name(error))])

        def fetch_cargo(self, generation):
            try:
                result = self.owner.sm.RemoteSvc(SVC).GetCargo()
                if generation == self.generation:
                    if not isinstance(result, dict):
                        self.cargo_ok = False
                        self.emit([_sw_item('ui.cargo', 'Absent')])
                    elif result.get('v') != WIRE:
                        self.emit([_sw_item('ui.wire', 'Mismatch')])
                    elif result.get('ok'):
                        self.cargo_data = result
                        self.forget_gone()
                        ids = [_sw_int(ship.get('shipItemID')) for ship in self.cargo_ships()]
                        if self.cargo_to not in ids:
                            self.cargo_to = _sw_int(result.get('hostShipID'))
                    else:
                        self.cargo_data = None
                        self.note = _sw_words(result.get('reason') or 'REFUSED', _SW_REASON_TEXT)
            except Exception as error:
                if generation == self.generation:
                    self.cargo_ok = False
                self.emit([_sw_item('ui.cargo', _sw_error_name(error))])
            if generation == self.generation:
                self.fetching = False
                if self.cargo_ok:
                    self.request_render()
                    if self.again:
                        self.again = False
                        self.cargo_refresh()
                else:
                    self.close('failed')
                    self.owner.window.request_render()
            elif self.fetching and self.fetch_generation == generation:
                self.fetching = False
                if self.again:
                    self.again = False
                    self.cargo_refresh()

        def cargo_move(self, item_id):
            try:
                if self.busy:
                    self.set_note('busy')
                    return
                if not self.cargo_to or not item_id:
                    self.set_note('nothing to do')
                    return
                self.busy = True
                self.set_note('Move...')
                _sw_uthread.new(self.move_cargo, item_id, self.cargo_to, self.generation)
            except Exception as error:
                self.busy = False
                self.emit([_sw_item('ui.cargo', 'click.' + _sw_error_name(error))])

        def move_cargo(self, item_id, target, generation):
            try:
                result = self.owner.sm.RemoteSvc(SVC).MoveCargo([item_id], target, None, None)
                if generation == self.generation:
                    if isinstance(result, dict) and result.get('v') == WIRE:
                        if result.get('ok'):
                            self.note = 'moved %d' % _sw_int(result.get('movedQty'))
                        else:
                            self.note = _sw_words(result.get('reason') or 'REFUSED', _SW_REASON_TEXT)
                    else:
                        self.emit([_sw_item('ui.cargo', 'move.Absent')])
            except Exception as error:
                self.emit([_sw_item('ui.cargo', 'move.' + _sw_error_name(error))])
            if generation == self.generation:
                self.busy = False
                if self.fetching:
                    self.again = True
                    return
                self.fetching = True
                self.fetch_generation = generation
                self.fetched_at = _sw_now()
                self.fetch_cargo(generation)

    class _ShipWingClient(object):
        __notifyevents__ = [NOTIFY_STATE, NOTIFY_OPEN, 'OnSessionChanged', 'OnDisconnect']

        def __init__(self, context):
            self.context = context
            self.active = True
            self.client_no = 0
            self.sm = None
            self.session = None
            self.character = None
            self.registered = []
            self.state = None
            self.generation = 0
            self.reported = set()
            self.reported_generation = 0
            self.window = _ShipWingWindow(self)
            self.cargo = _ShipWingCargoWindow(self)

        def lookup(self, name):
            return self.context.get(name, getattr(_sw_builtins, name, None))

        def current(self):
            return self.active and getattr(_sw_builtins, _SW_KEY, None) is self

        def client_build(self):
            try:
                return int(getattr(self.lookup('boot'), 'build', 0))
            except Exception:
                return 0

        def dispose(self):
            self.active = False
            try:
                self.window.close('dispose')
            except Exception:
                pass
            self.close_cargo('dispose')
            self.generation += 1
            self.state = None
            for event in self.registered:
                try:
                    self.sm.UnregisterForNotifyEvent(self, event)
                except Exception:
                    pass
            self.registered = []

        def close_cargo(self, where):
            try:
                self.cargo.close(where)
            except Exception:
                pass
            if where in ('session', 'dispose'):
                try:
                    self.cargo.forget()
                except Exception:
                    pass

        def cargo_watch(self):
            try:
                self.cargo.watch()
            except Exception as error:
                self.report([_sw_item('ui.cargo.state', _sw_error_name(error))])

        def cargo_state(self, previous):
            try:
                self.cargo.state_changed(previous)
            except Exception as error:
                self.report([_sw_item('ui.cargo.state', _sw_error_name(error))])

        def report(self, items):
            sm = self.sm
            if sm is None:
                return
            if self.reported_generation != self.generation:
                self.reported_generation = self.generation
                self.reported = set()
            fresh = []
            for item in items:
                if item in self.reported or len(self.reported) >= _SW_MAX_REPORTED:
                    continue
                self.reported.add(item)
                fresh.append(item)
            if not fresh:
                return
            def send():
                try:
                    sm.RemoteSvc(SVC).Report(PROTO, self.client_no, fresh[:MAX_REPORT_ITEMS])
                except Exception:
                    pass
            try:
                _sw_uthread.new(send)
            except Exception:
                pass

        def fail(self, error, where='run'):
            name = _sw_error_name(error)
            print('SHIPWING_UI:UNAVAILABLE:%s:%s' % (where, name))
            self.report([_sw_item('ui.fail.' + where, name)])
            self.dispose()

        def handler_error(self, where, error):
            name = _sw_error_name(error)
            print('SHIPWING_UI:ERROR:%s:%s' % (where, name))
            self.report([_sw_item('ui.error.' + where, name)])

        def take_state(self, snapshot, items=None):
            if not isinstance(snapshot, dict) or snapshot.get('ok') is False:
                return False
            if snapshot.get('v') != WIRE:
                if items is None:
                    self.report([_sw_item('ui.wire', 'Mismatch')])
                else:
                    items.append(_sw_item('ui.wire', 'Mismatch'))
                return False
            self.state = snapshot
            return True

        def deployed(self):
            if isinstance(self.state, dict):
                return _sw_int(self.state.get('deployed'))
            return 0

        def wait_for_session(self):
            for attempt in range(_SW_WAIT_STEPS):
                if not self.current():
                    return False
                self.sm = self.lookup('sm')
                self.session = self.lookup('session')
                if self.sm is not None and self.session is not None:
                    return True
                _sw_blue.pyos.synchro.SleepWallclock(_SW_WAIT_MS)
            return False

        def run(self):
            try:
                if not self.wait_for_session():
                    print('SHIPWING_UI:UNAVAILABLE:WAIT')
                    self.dispose()
                    return
                build = self.client_build()
                if build not in BUILDS:
                    try:
                        self.sm.RemoteSvc(SVC).Report(PROTO, max(0, build), ['build=0:UNSUPPORTED_BUILD'])
                    except Exception:
                        pass
                    print('SHIPWING_UI:UNSUPPORTED_BUILD')
                    self.dispose()
                    return
                self.client_no = build
                for event in self.__notifyevents__:
                    self.sm.RegisterForNotifyEvent(self, event)
                    self.registered.append(event)
                self.character = getattr(self.session, 'charid', None)
                if self.character:
                    self.connect(self.generation)
                else:
                    print('SHIPWING_UI:WAITING_FOR_CHARACTER')
            except Exception as error:
                self.fail(error, 'run')

        def connect(self, generation):
            try:
                svc = self.sm.RemoteSvc(SVC)
                state = svc.GetState()
                if not self.current() or generation != self.generation:
                    return
                self.take_state(state)
                items = self.probe()
                if not self.current() or generation != self.generation:
                    return
                svc.Report(PROTO, self.client_no, items)
                print('SHIPWING_UI:READY')
            except Exception as error:
                self.fail(error, 'connect')

        def probe(self):
            items = []
            for key, module, attribute in _SW_PROBE_MODULES:
                error = None
                try:
                    loaded = __import__(module, fromlist=[attribute])
                    if not hasattr(loaded, attribute):
                        error = 'NoAttr'
                except Exception as exc:
                    error = _sw_error_name(exc)
                items.append(_sw_item(key, error))
            for key, name, attribute in _SW_PROBE_SERVICES:
                error = None
                try:
                    if not hasattr(self.sm.GetService(name), attribute):
                        error = 'NoAttr'
                except Exception as exc:
                    error = _sw_error_name(exc)
                items.append(_sw_item(key, error))
            for key, module, attribute, method in _SW_PROBE_ATTRS:
                error = None
                try:
                    if not hasattr(getattr(__import__(module, fromlist=[attribute]), attribute), method):
                        error = 'NoAttr'
                except Exception as exc:
                    error = _sw_error_name(exc)
                items.append(_sw_item(key, error))
            for key, owner in (('dcb', '_evejs_ourmods_fitting_runtime'), ('moon', '_evejs_moon_transient_names')):
                if getattr(_sw_builtins, owner, None) is not None:
                    items.append(_sw_item(key, None))
                else:
                    items.append(_sw_item(key, 'Absent'))
            return items[:MAX_REPORT_ITEMS]

        def OnShipWingState(self, snapshot=None, *args):
            try:
                if not self.current():
                    return
                before = self.deployed()
                previous = self.state
                if not self.take_state(snapshot):
                    return
                self.cargo_state(previous)
                window = self.window
                if window.is_open():
                    window.state_changed(previous)
                elif (not window.auto_opened and before == 0 and self.deployed() > 0
                      and (snapshot.get('ui') or {}).get('autoOpen') is True):
                    window.auto_opened = True
                    _sw_uthread.new(self.open_window, snapshot, self.generation, [])
            except Exception as error:
                self.handler_error('state', error)

        def OnShipWingOpen(self, snapshot=None, *args):
            try:
                if not self.current():
                    return
                items = []
                if self.take_state(snapshot, items):
                    _sw_uthread.new(self.open_window, snapshot, self.generation, items)
                else:
                    _sw_uthread.new(self.show_open, snapshot, self.generation, items)
            except Exception as error:
                self.handler_error('open', error)

        def open_window(self, snapshot, generation, items):
            shown = False
            try:
                if not self.current() or generation != self.generation:
                    return
                shown = self.window.open(snapshot, items)
            except Exception as error:
                items.append(_sw_item('ui.win', _sw_error_name(error)))
            if not shown:
                self.notice(snapshot, generation, items)
            self.report(items)

        def open_text(self, snapshot):
            deployed = 0
            limit = 0
            ships = 0
            if isinstance(snapshot, dict):
                deployed = int(snapshot.get('deployed') or 0)
                limit = int(snapshot.get('limit') or 0)
                ships = len(snapshot.get('ships') or ())
            return 'Ship Wing: %d/%d out, %d ships' % (deployed, limit, ships)

        def show_open(self, snapshot, generation, items):
            self.notice(snapshot, generation, items)
            self.report(items)

        def notice(self, snapshot, generation, items):
            try:
                if not self.current() or generation != self.generation:
                    return
                text = self.open_text(snapshot)
                print(text)
                shown = False
                try:
                    show = getattr(self.lookup('eve'), 'Message', None)
                    if show is None:
                        items.append(_sw_item('ui.open.message', 'Absent'))
                    else:
                        show('CustomNotify', {'notify': text})
                        shown = True
                except Exception as exc:
                    items.append(_sw_item('ui.open.message', _sw_error_name(exc)))
                if not shown:
                    try:
                        say = getattr(self.sm.GetService('gameui'), 'Say', None)
                        if say is None:
                            items.append(_sw_item('ui.open.say', 'Absent'))
                        else:
                            say(text)
                            shown = True
                    except Exception as exc:
                        items.append(_sw_item('ui.open.say', _sw_error_name(exc)))
                items.append(_sw_item('ui.open', None if shown else 'NotShown'))
            except Exception as error:
                items.append(_sw_item('ui.open', _sw_error_name(error)))

        def OnSessionChanged(self, *args):
            try:
                if not self.current():
                    return
                character = getattr(self.session, 'charid', None)
                if character == self.character:
                    return
                self.window.close('session')
                self.close_cargo('session')
                self.window.auto_opened = False
                self.window.selected = set()
                self.window.reasons = {}
                self.generation += 1
                self.state = None
                self.character = character
                if character:
                    _sw_uthread.new(self.connect, self.generation)
            except Exception as error:
                self.handler_error('session', error)

        def OnDisconnect(self, *args):
            self.dispose()

    _sw_previous = getattr(_sw_builtins, _SW_KEY, None)
    if _sw_previous is not None:
        try:
            _sw_previous.dispose()
        except Exception:
            pass
    _sw_owner = _ShipWingClient(_sw_context)
    setattr(_sw_builtins, _SW_KEY, _sw_owner)
    _sw_uthread.new(_sw_owner.run)
    print('SHIPWING_UI:DELIVERED')
except Exception:
    print('SHIPWING_UI:UNAVAILABLE:DELIVERY')
