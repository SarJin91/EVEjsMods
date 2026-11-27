try:
    import __builtin__ as _lne_builtins
    import uthread as _lne_uthread
    import blue as _lne_blue

    PROTO = 1
    WIRE = 1
    BUILDS = (3396210, 3724492)
    SVC = 'lneBoardSvc'
    NOTIFY_OPEN = 'OnLneBoardOpen'
    MAX_REPORT_ITEMS = 64
    MAX_REPORT_ITEM_CHARS = 96

    _LNE_KEY = '__lne_board_instance'
    _LNE_WAIT_STEPS = 240
    _LNE_WAIT_MS = 500

    WINDOW_ID = 'lneBoardWindow1'
    CAPTION = 'LNE Board'
    _LNE_DEFAULT_SIZE = (600, 440)
    _LNE_MIN_SIZE = (440, 240)
    _LNE_LINE_HEIGHT = 18
    _LNE_BUTTON_HEIGHT = 24
    _LNE_GAP = 6
    _LNE_BUTTON_GAP = 4
    _LNE_TITLE_CHARS = 80
    _LNE_TEXT_CHARS = 96
    _LNE_NEAR_PREFIXES = ('nearby', 'events', 'heavy', 'salvage')
    _LNE_STEP_MS = 500
    _LNE_MIN_POLL_MS = 5000
    _LNE_DIM_COLOR = (0.85, 0.7, 0.45, 0.8)
    _LNE_SOLAR_SYSTEM_TYPE = 5
    _LNE_MAX_REPORTED = 64
    _LNE_REPORT_RETRIES = 3
    _LNE_RETRY_MS = (1000, 3600000)

    _LNE_WINDOW_CLASSES = (
        ('eve', 'eve.client.script.ui.control.eveWindow', 'Window'),
        ('carbon', 'carbonui.control.window', 'Window'),
    )
    _LNE_BUTTON_CLASSES = (
        ('eve', 'eve.client.script.ui.control.buttons', 'Button'),
        ('carbon', 'carbonui.control.button', 'Button'),
    )
    _LNE_SCROLL_CLASSES = (
        ('carbon', 'carbonui.control.scrollContainer', 'ScrollContainer'),
    )
    _LNE_CONT_CLASSES = (
        ('carbon', 'carbonui.primitives.container', 'Container'),
    )
    _LNE_LABEL_CLASSES = (
        ('eve', 'eve.client.script.ui.control.eveLabel', 'EveLabelSmall'),
        ('carbon', 'carbonui.control.label', 'Label'),
    )
    _LNE_CONST_MODULES = ('carbonui.uiconst', 'carbonui.const')
    _LNE_ACTIONS = (
        ('starmap.SetWaypoint', 'starmap', 'SetWaypoint'),
        ('info.ShowInfo', 'info', 'ShowInfo'),
        ('contracts.ShowContract', 'contracts', 'ShowContract'),
    )

    def _lne_item(key, error):
        if error is None:
            text = key + '=1'
        else:
            text = key + '=0:' + error
        return text[:MAX_REPORT_ITEM_CHARS]

    def _lne_error_name(error):
        try:
            return type(error).__name__
        except Exception:
            return 'Exception'

    def _lne_int(value):
        try:
            return int(value)
        except Exception:
            return 0

    def _lne_text(value, chars):
        text = '%s' % (value if value is not None else '')
        if len(text) > chars:
            return text[:max(1, chars - 2)] + '..'
        return text

    def _lne_pick(candidates):
        for variant, module, attribute in candidates:
            try:
                loaded = __import__(module, fromlist=[attribute])
            except Exception:
                continue
            found = getattr(loaded, attribute, None)
            if found is not None:
                return variant, found
        return None, None

    def _lne_uiconst():
        for module in _LNE_CONST_MODULES:
            try:
                loaded = __import__(module, fromlist=['TOTOP'])
            except Exception:
                continue
            if hasattr(loaded, 'TOTOP'):
                return loaded
        raise NoConst()

    def _lne_duration(seconds):
        seconds = max(0, _lne_int(seconds))
        if seconds <= 0:
            return '-'
        days = seconds // 86400
        hours = (seconds % 86400) // 3600
        minutes = (seconds % 3600) // 60
        if days > 0:
            return '%dd %dh' % (days, hours)
        if hours > 0:
            return '%dh %dm' % (hours, minutes)
        if minutes > 0:
            return '%dm' % minutes
        return '<1m'

    _LNE_SIG_SKIP = ('at', 'ageS')
    _LNE_SIG_DURATION = ('endsIn', 'age')

    def _lne_frozen(value):
        if isinstance(value, dict):
            items = []
            for key, item in value.items():
                if key in _LNE_SIG_SKIP:
                    continue
                if key in _LNE_SIG_DURATION:
                    item = _lne_duration(item)
                items.append(('%s' % key, _lne_frozen(item)))
            return tuple(sorted(items, key=lambda kv: kv[0]))
        if isinstance(value, (list, tuple)):
            return tuple([_lne_frozen(item) for item in value])
        return value

    def _lne_jumps(jumps):
        jumps = _lne_int(jumps)
        if jumps < 0:
            return 'far'
        if jumps == 0:
            return 'here'
        return '%dj' % jumps

    def _lne_wanted(row):
        text = '  %s L%d %s' % (_lne_text(row.get('nick'), 37), _lne_int(row.get('lv')), _lne_text(row.get('rw'), 16))
        if row.get('sm') is True:
            text += ' (smuggler)'
        seen = _lne_text(row.get('seen'), 40)
        if not seen:
            return text + ' - no recent sightings'
        kind = row.get('kind')
        if kind in ('constellation', 'region'):
            seen = '%s %s' % (kind, seen)
        text += ' - seen %s, %s ago' % (seen, _lne_duration(max(1, _lne_int(row.get('age')))))
        if _lne_int(row.get('j')) >= 0 and row.get('j') is not None:
            text += ' (%s)' % _lne_jumps(row.get('j'))
        return text

    class NoClass(Exception):
        pass

    class NoParent(Exception):
        pass

    class NoWindow(Exception):
        pass

    class NoConst(Exception):
        pass

    class _LneBoardWindow(object):

        def __init__(self, owner):
            self.owner = owner
            self.win = None
            self.cls = None
            self.body = None
            self.const = None
            self.classes = {}
            self.generation = 0
            self.busy = False
            self.pinning = False
            self.note = ''
            self.step = 'open'
            self.drawn = None
            self.holder = None
            self.scroll_ok = True

        def make(self, kind, candidates):
            found = self.classes.get(kind)
            if found is None:
                variant, found = _lne_pick(candidates)
                if found is None:
                    raise NoClass()
                self.classes[kind] = found
            return found

        def place(self, cls, extra, **kw):
            if extra:
                try:
                    merged = dict(kw)
                    merged.update(extra)
                    return cls(**merged)
                except Exception:
                    pass
            return cls(**kw)

        def fit(self, cont, controls, floor):
            height = floor
            for control in controls:
                height = max(height, _lne_int(getattr(control, 'height', 0)))
            cont.height = height
            return height

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
                    win = cls.Open(windowID=WINDOW_ID, caption=CAPTION, minSize=_LNE_MIN_SIZE,
                                   width=_LNE_DEFAULT_SIZE[0], height=_LNE_DEFAULT_SIZE[1])
                except TypeError:
                    win = cls.Open(windowID=WINDOW_ID, caption=CAPTION)
                if win is None and hasattr(cls, 'GetIfOpen'):
                    win = cls.GetIfOpen(windowID=WINDOW_ID)
            else:
                win = cls(windowID=WINDOW_ID, caption=CAPTION)
            if win is None:
                raise NoWindow()
            return win

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
                gone = getter(windowID=WINDOW_ID) is None
            except Exception:
                return False
            if gone:
                try:
                    win.Close()
                except Exception:
                    pass
            return gone

        def open(self):
            items = []
            if self.is_open() and not self.player_closed():
                return True
            self.close('reopen')
            generation = self.generation
            self.step = 'class'
            try:
                variant, cls = _lne_pick(_LNE_WINDOW_CLASSES)
                if cls is None:
                    raise NoClass()
                self.cls = cls
                try:
                    getter = getattr(cls, 'GetIfOpen', None)
                    old = getter(windowID=WINDOW_ID) if getter is not None else None
                    if old is not None:
                        old.Close()
                except Exception as error:
                    items.append(_lne_item('ui.close', _lne_error_name(error)))
                self.step = 'window'
                self.win = self.create(cls)
                self.step = 'parent'
                parent, where = self.find_parent(self.win)
                self.const = _lne_uiconst()
                self.body = self.make('cont', _LNE_CONT_CLASSES)(parent=parent, align=self.const.TOALL)
                self.build(None)
            except Exception as error:
                items.append(_lne_item('ui.win', '%s.%s' % (self.step, _lne_error_name(error))))
                self.close('build')
                self.owner.report(items)
                return False
            items.append(_lne_item('ui.win.' + variant, None))
            self.owner.report(items)
            _lne_uthread.new(self.loop, generation)
            return True

        def close(self, where):
            win = self.win
            cls = self.cls
            self.generation += 1
            self.win = None
            self.body = None
            self.busy = False
            self.pinning = False
            self.drawn = None
            self.holder = None
            if win is None or where == 'player':
                return
            try:
                win.Close()
            except Exception as error:
                try:
                    closer = getattr(cls, 'CloseByID', None)
                    if closer is not None:
                        closer(windowID=WINDOW_ID)
                except Exception:
                    pass
                self.owner.report([_lne_item('ui.close', _lne_error_name(error))])

        def loop(self, generation):
            waited = 0
            try:
                while self.alive(generation):
                    _lne_blue.pyos.synchro.SleepWallclock(_LNE_STEP_MS)
                    if not self.alive(generation):
                        return
                    if self.player_closed():
                        self.close('player')
                        return
                    waited += _LNE_STEP_MS
                    poll = self.poll_ms()
                    if poll > 0 and waited >= poll:
                        waited = 0
                        self.refresh(generation)
            except Exception as error:
                self.owner.report([_lne_item('ui.loop', _lne_error_name(error))])
                if generation == self.generation:
                    self.close('loop')

        def poll_ms(self):
            try:
                poll = _lne_int(self.owner.state.get('ui').get('pollMs'))
            except Exception:
                return 0
            if poll <= 0:
                return 0
            return max(_LNE_MIN_POLL_MS, poll)

        def refresh(self, generation=None):
            if generation is None:
                generation = self.generation
            if self.busy or not self.alive(generation):
                return
            self.busy = True
            try:
                try:
                    data = self.owner.sm.RemoteSvc(SVC).GetBoard()
                except Exception as error:
                    self.note = 'server unreachable'
                    self.owner.report([_lne_item('ui.get', _lne_error_name(error))])
                    data = None
                if not self.alive(generation):
                    return
                if isinstance(data, dict) and data.get('ok') is not False and data.get('v') == WIRE:
                    self.owner.state = data
                    self.note = ''
                elif isinstance(data, dict) and data.get('ok') is False:
                    self.note = ('%s' % (data.get('reason') or 'refused')).lower().replace('_', ' ')
                elif data is not None:
                    self.note = 'other version'
                    self.owner.report([_lne_item('ui.wire', 'Mismatch')])
                self.render(generation)
            finally:
                if generation == self.generation:
                    self.busy = False

        def refresh_handler(self):
            return lambda *a, **k: _lne_uthread.new(self.refresh, self.generation)

        def signature(self, data):
            available = getattr(self.owner, 'available', None)
            available = tuple(sorted(available.items())) if isinstance(available, dict) else ()
            return (_lne_frozen(data if isinstance(data, dict) else {}), self.note, available)

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

        def render(self, generation):
            if not self.alive(generation):
                return
            if self.drawn is not None and self.drawn == self.signature(self.owner.state):
                return
            try:
                self.build(self.owner.state)
            except Exception as error:
                self.owner.report([_lne_item('ui.render', '%s.%s' % (self.step, _lne_error_name(error)))])
                self.close('render')

        def action(self, key, service, method, *args, **kw):
            try:
                svc = self.owner.sm.GetService(service)
                getattr(svc, method)(*args, **kw)
            except TypeError:
                try:
                    getattr(self.owner.sm.GetService(service), method)(*args)
                except Exception as error:
                    self.owner.report([_lne_item('act.' + key, _lne_error_name(error))])
            except Exception as error:
                self.owner.report([_lne_item('act.' + key, _lne_error_name(error))])

        def route_handler(self, system_id):
            return lambda *a, **k: self.action('route', 'starmap', 'SetWaypoint', system_id, clearOtherWaypoints=True)

        def info_handler(self, system_id):
            return lambda *a, **k: self.action('info', 'info', 'ShowInfo', _LNE_SOLAR_SYSTEM_TYPE, system_id)

        def contract_handler(self, contract_id):
            return lambda *a, **k: self.action('contract', 'contracts', 'ShowContract', contract_id)

        def pin_handler(self, ref, on):
            return lambda *a, **k: _lne_uthread.new(self.pin, ref, on, self.generation)

        def pin(self, ref, on, generation):
            if self.pinning or not self.alive(generation):
                return
            self.pinning = True
            try:
                try:
                    svc = self.owner.sm.RemoteSvc(SVC)
                    answer = svc.Pin(ref) if on else svc.Unpin(ref)
                except Exception as error:
                    self.note = 'server unreachable'
                    self.owner.report([_lne_item('act.pin', _lne_error_name(error))])
                    answer = None
                if not self.alive(generation):
                    return
                if isinstance(answer, dict) and answer.get('ok') is True:
                    self.note = ''
                    state = self.owner.state if isinstance(self.owner.state, dict) else {}
                    for key in ('jobs', 'mine'):
                        for row in (state.get(key) or ()):
                            if isinstance(row, dict) and row.get('ref') == ref:
                                row['pin'] = 2 if on else 1
                elif isinstance(answer, dict):
                    self.note = ('%s' % (answer.get('reason') or 'refused')).lower().replace('_', ' ')
                self.render(generation)
            finally:
                if generation == self.generation:
                    self.pinning = False

        def ui_flag(self, name):
            try:
                return self.owner.state.get('ui').get(name) is True
            except Exception:
                return False

        def build(self, data):
            self.step = 'header'
            const = self.const
            cont = self.make('cont', _LNE_CONT_CLASSES)
            button = self.make('button', _LNE_BUTTON_CLASSES)
            label = self.make('label', _LNE_LABEL_CLASSES)
            clip = {'clipChildren': True}
            position = self.scroll_position()
            self.holder = None
            self.drawn = None
            self.flush(self.body)
            data = data if isinstance(data, dict) else {}
            header = self.place(cont, {'padBottom': _LNE_GAP}, parent=self.body, align=const.TOTOP,
                                height=_LNE_BUTTON_HEIGHT)
            refresh = self.place(button, {'padLeft': _LNE_BUTTON_GAP}, parent=header, label='Refresh',
                                 func=self.refresh_handler(), align=const.TORIGHT)
            self.fit(header, [refresh], _LNE_BUTTON_HEIGHT)
            box = self.place(cont, clip, parent=header, align=const.TOALL)
            where = _lne_text(data.get('sysName') or '', 32)
            title = 'Near %s' % where if where else 'Loading...'
            if self.note:
                title += ' - %s' % self.note
            label(parent=box, text=title, align=const.TOLEFT)
            self.step = 'scroll'
            scroll_variant, scroll = _lne_pick(_LNE_SCROLL_CLASSES)
            holder = None
            if scroll is not None:
                try:
                    holder = scroll(parent=self.body, align=const.TOALL)
                except Exception:
                    holder = None
            scrolled = holder is not None
            if holder is None:
                holder = cont(parent=self.body, align=const.TOALL)
            if data:
                self.fill(holder, data)
            if scrolled:
                self.holder = holder
                self.scroll_restore(holder, position)
            self.drawn = self.signature(data)

        def fill(self, holder, data):
            more = data.get('more') if isinstance(data.get('more'), dict) else {}
            refusals = ['%s' % r for r in (data.get('refusals') or ())]
            if 'mine' in data:
                self.step = 'mine'
                self.section(holder, 'Mine', data.get('mine'), _lne_int(more.get('mine')),
                             [r for r in refusals if r.startswith('mine:')], False)
            self.step = 'jobs'
            self.section(holder, 'Front jobs', data.get('jobs'), _lne_int(more.get('jobs')),
                         [r for r in refusals if r.startswith('frontJobs:')], False)
            self.step = 'wars'
            self.section(holder, 'War contracts', data.get('wars'), _lne_int(more.get('wars')),
                         [r for r in refusals if r.startswith('warContracts:')], True)
            if 'near' in data:
                self.step = 'near'
                self.section(holder, 'Nearby', data.get('near'), _lne_int(more.get('near')),
                             [r for r in refusals if r.split(':')[0] in _LNE_NEAR_PREFIXES], 'near')
            front = data.get('front') if isinstance(data.get('front'), dict) else {}
            front_refused = [r for r in refusals if r.startswith('front:')]
            if 'front' in data or front_refused:
                self.step = 'front'
                self.text_section(holder, 'Front', front.get('lines') or (), front_refused)
            news = data.get('news') if isinstance(data.get('news'), dict) else {}
            news_refused = [r for r in refusals if r.startswith('news:')]
            if 'news' in data or news_refused:
                self.step = 'news'
                lines = []
                if news:
                    lines.append('#%d %s' % (_lne_int(news.get('seq')), _lne_text(news.get('title'), 100)))
                    text = '%s' % (news.get('text') or '')
                    while text:
                        lines.append(text[:_LNE_TEXT_CHARS])
                        text = text[_LNE_TEXT_CHARS:]
                self.text_section(holder, 'News', lines, news_refused)
            wanted = data.get('wanted') if isinstance(data.get('wanted'), dict) else {}
            wanted_refused = [r for r in refusals if r.startswith('wanted:')]
            if 'wanted' in data or wanted_refused:
                self.step = 'wanted'
                lines = []
                total = [_lne_int(n) for n in (wanted.get('s') or ())]
                if total:
                    lines.append('%d wanted across New Eden (%s)' % (total[0], ', '.join(
                        'L%d %d' % (i, n) for i, n in enumerate(total[1:], 1) if n > 0) or 'none'))
                for name, key in (('Near you', 'n'), ('Most wanted', 't')):
                    rows = [r for r in (wanted.get(key) or ()) if isinstance(r, dict)]
                    if rows:
                        lines.append(name + ':')
                        lines.extend((_lne_wanted(r), _lne_int(r.get('sid')) if r.get('seen') else -1) for r in rows)
                if _lne_int(wanted.get('m')) > 0:
                    lines.append('+%d more' % _lne_int(wanted.get('m')))
                self.text_section(holder, 'Wanted', lines, wanted_refused)

        def text_section(self, holder, name, lines, refusals):
            const = self.const
            cont = self.make('cont', _LNE_CONT_CLASSES)
            label = self.make('label', _LNE_LABEL_CLASSES)
            text = name + (' - unavailable (%s)' % refusals[0].split(':', 1)[-1].lower() if refusals else '')
            line = self.place(cont, {'padTop': _LNE_GAP}, parent=holder, align=const.TOTOP, height=_LNE_LINE_HEIGHT)
            label(parent=line, text=text, align=const.TOLEFT)
            available = self.owner.available
            for value in lines:
                system_id = -1
                if isinstance(value, tuple):
                    value, system_id = value[0], _lne_int(value[1])
                buttons = []
                if system_id > 0:
                    button = self.make('button', _LNE_BUTTON_CLASSES)
                    gap = {'padLeft': _LNE_BUTTON_GAP}
                    row = cont(parent=holder, align=const.TOTOP, height=_LNE_BUTTON_HEIGHT)
                    if available.get('info.ShowInfo'):
                        buttons.append(self.place(button, gap, parent=row, label='Info', align=const.TORIGHT,
                                                  func=self.info_handler(system_id)))
                    if self.ui_flag('travel') and available.get('starmap.SetWaypoint'):
                        buttons.append(self.place(button, gap, parent=row, label='Route', align=const.TORIGHT,
                                                  func=self.route_handler(system_id)))
                    self.fit(row, buttons, _LNE_BUTTON_HEIGHT if buttons else _LNE_LINE_HEIGHT)
                    row = self.place(cont, {'clipChildren': True}, parent=row, align=const.TOALL)
                else:
                    row = self.place(cont, {'clipChildren': True}, parent=holder, align=const.TOTOP,
                                     height=_LNE_LINE_HEIGHT)
                self.place(label, {'color': _LNE_DIM_COLOR}, parent=row, text=_lne_text(value, _LNE_TEXT_CHARS),
                           align=const.TOLEFT)

        def section(self, holder, name, rows, more, refusals, wars):
            const = self.const
            cont = self.make('cont', _LNE_CONT_CLASSES)
            label = self.make('label', _LNE_LABEL_CLASSES)
            rows = [row for row in (rows or ()) if isinstance(row, dict)]
            text = '%s (%d)' % (name, len(rows))
            if more > 0:
                text += ', +%d more' % more
            if refusals:
                text += ' - unavailable'
            line = self.place(cont, {'padTop': _LNE_GAP}, parent=holder, align=const.TOTOP, height=_LNE_LINE_HEIGHT)
            label(parent=line, text=text, align=const.TOLEFT)
            if not rows and not refusals:
                empty = cont(parent=holder, align=const.TOTOP, height=_LNE_LINE_HEIGHT)
                self.place(label, {'color': _LNE_DIM_COLOR}, parent=empty, text='none', align=const.TOLEFT)
            for row in rows:
                self.add_row(holder, row, wars)

        def add_row(self, holder, row, wars):
            const = self.const
            cont = self.make('cont', _LNE_CONT_CLASSES)
            button = self.make('button', _LNE_BUTTON_CLASSES)
            label = self.make('label', _LNE_LABEL_CLASSES)
            clip = {'clipChildren': True}
            gap = {'padLeft': _LNE_BUTTON_GAP}
            system_id = _lne_int(row.get('sys'))
            frame = self.place(cont, {'padBottom': _LNE_GAP}, parent=holder, align=const.TOTOP,
                               height=_LNE_LINE_HEIGHT + _LNE_BUTTON_HEIGHT)
            top = cont(parent=frame, align=const.TOTOP, height=_LNE_BUTTON_HEIGHT)
            buttons = []
            available = self.owner.available
            pin = _lne_int(row.get('pin'))
            title = _lne_text(row.get('title'), _LNE_TITLE_CHARS)
            if wars == 'near':
                if row.get('scan') is True:
                    title = '[SIG] ' + title
                if row.get('level'):
                    title += ' [%s]' % _lne_text(row.get('level'), 10)
            if wars is False and pin in (1, 2) and self.ui_flag('pins'):
                buttons.append(self.place(button, gap, parent=top, label='Accept' if pin == 1 else 'Drop',
                                          align=const.TORIGHT, func=self.pin_handler(row.get('ref'), pin == 1)))
            if wars is True and _lne_int(row.get('contractId')) > 0 and self.ui_flag('contracts') \
                    and available.get('contracts.ShowContract'):
                buttons.append(self.place(button, gap, parent=top, label='Contract', align=const.TORIGHT,
                                          func=self.contract_handler(_lne_int(row.get('contractId')))))
            if system_id > 0 and available.get('info.ShowInfo'):
                buttons.append(self.place(button, gap, parent=top, label='Info', align=const.TORIGHT,
                                          func=self.info_handler(system_id)))
            if system_id > 0 and self.ui_flag('travel') and available.get('starmap.SetWaypoint'):
                buttons.append(self.place(button, gap, parent=top, label='Route', align=const.TORIGHT,
                                          func=self.route_handler(system_id)))
            high = self.fit(top, buttons, _LNE_BUTTON_HEIGHT)
            title_box = self.place(cont, clip, parent=top, align=const.TOALL)
            label(parent=title_box, text=title, align=const.TOLEFT)
            low = cont(parent=frame, align=const.TOTOP, height=_LNE_LINE_HEIGHT)
            low_box = self.place(cont, clip, parent=low, align=const.TOALL)
            self.place(label, {'color': _LNE_DIM_COLOR}, parent=low_box, text=self.detail(row, wars),
                       align=const.TOLEFT)
            frame.height = high + _LNE_LINE_HEIGHT

        def detail(self, row, wars):
            parts = ['%s (%s)' % (_lne_text(row.get('sysName'), 32), _lne_jumps(row.get('jumps'))),
                     _lne_text(row.get('reward'), 60)]
            if wars == 'near':
                parts = [p for p in parts if p] + [_lne_text(row.get('state'), 16)]
            elif not wars:
                progress = _lne_text(row.get('progress'), 24)
                mine = _lne_text(row.get('mine'), 24)
                parts.append(progress + (', mine %s' % mine if mine else ''))
                parts.append(_lne_text(row.get('state'), 16))
            if _lne_int(row.get('endsIn')) > 0:
                parts.append('ends in %s' % _lne_duration(row.get('endsIn')))
            return '  |  '.join(parts)

    class _LneBoardClient(object):
        __notifyevents__ = [NOTIFY_OPEN, 'OnSessionChanged', 'OnDisconnect']

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
            self.available = {}
            self.reported = set()
            self.queued = []
            self.sender = None
            self.window = _LneBoardWindow(self)

        def lookup(self, name):
            return self.context.get(name, getattr(_lne_builtins, name, None))

        def current(self):
            return self.active and getattr(_lne_builtins, _LNE_KEY, None) is self

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
            self.generation += 1
            self.state = None
            for event in self.registered:
                try:
                    self.sm.UnregisterForNotifyEvent(self, event)
                except Exception:
                    pass
            self.registered = []

        def report(self, items):
            if self.sm is None:
                return
            for item in items:
                if item in self.reported or item in self.queued:
                    continue
                if len(self.reported) + len(self.queued) >= _LNE_MAX_REPORTED:
                    break
                self.queued.append(item)
            if self.queued and self.sender != self.generation:
                self.sender = self.generation
                try:
                    _lne_uthread.new(self.flush, self.generation)
                except Exception:
                    self.sender = None

        def flush(self, generation):
            retries = 0
            try:
                while self.queued and self.current() and generation == self.generation:
                    batch = self.queued[:MAX_REPORT_ITEMS]
                    answer = self.sm.RemoteSvc(SVC).Report(PROTO, self.client_no, batch)
                    if not self.current() or generation != self.generation:
                        return
                    if isinstance(answer, dict) and answer.get('ok') is False:
                        if answer.get('reason') != 'RATE_LIMIT' or retries >= _LNE_REPORT_RETRIES:
                            return
                        retries += 1
                        wait = min(max(_lne_int(answer.get('retryMs')), _LNE_RETRY_MS[0]), _LNE_RETRY_MS[1])
                        _lne_blue.pyos.synchro.SleepWallclock(wait)
                        continue
                    for item in batch:
                        self.reported.add(item)
                        if item in self.queued:
                            self.queued.remove(item)
            except Exception:
                pass
            finally:
                if self.sender == generation:
                    self.sender = None

        def fail(self, error, where):
            print('LNE_BOARD_UI:UNAVAILABLE:%s:%s' % (where, _lne_error_name(error)))
            self.dispose()

        def wait_for_session(self):
            for attempt in range(_LNE_WAIT_STEPS):
                if not self.current():
                    return False
                self.sm = self.lookup('sm')
                self.session = self.lookup('session')
                if self.sm is not None and self.session is not None:
                    return True
                _lne_blue.pyos.synchro.SleepWallclock(_LNE_WAIT_MS)
            return False

        def run(self):
            try:
                if not self.wait_for_session():
                    print('LNE_BOARD_UI:UNAVAILABLE:WAIT')
                    self.dispose()
                    return
                build = self.client_build()
                if build not in BUILDS:
                    try:
                        self.sm.RemoteSvc(SVC).Report(PROTO, max(0, build), ['build=0:UNSUPPORTED_BUILD'])
                    except Exception:
                        pass
                    print('LNE_BOARD_UI:UNSUPPORTED_BUILD')
                    self.dispose()
                    return
                self.client_no = build
                for event in self.__notifyevents__:
                    self.sm.RegisterForNotifyEvent(self, event)
                    self.registered.append(event)
                self.character = getattr(self.session, 'charid', None)
                if self.character:
                    self.connect(self.generation)
            except Exception as error:
                self.fail(error, 'run')

        def connect(self, generation):
            try:
                items = self.probe()
                if not self.current() or generation != self.generation:
                    return
                self.reported = set()
                self.queued = []
                self.report(items[:MAX_REPORT_ITEMS])
                print('LNE_BOARD_UI:READY')
            except Exception as error:
                self.fail(error, 'connect')

        def probe(self):
            items = []
            for key, candidates in (('win', _LNE_WINDOW_CLASSES), ('button', _LNE_BUTTON_CLASSES),
                                    ('scroll', _LNE_SCROLL_CLASSES)):
                variant, found = _lne_pick(candidates)
                items.append(_lne_item(key, None if found is not None else 'Absent'))
            available = {}
            for key, service, method in _LNE_ACTIONS:
                error = None
                try:
                    if not hasattr(self.sm.GetService(service), method):
                        error = 'NoAttr'
                except Exception as exc:
                    error = _lne_error_name(exc)
                available[key] = error is None
                items.append(_lne_item(key, error))
            self.available = available
            return items

        def OnLneBoardOpen(self, payload=None, *args):
            try:
                if not self.current():
                    return
                _lne_uthread.new(self.open_window, self.generation)
            except Exception as error:
                print('LNE_BOARD_UI:ERROR:open:%s' % _lne_error_name(error))

        def open_window(self, generation):
            try:
                if not self.current() or generation != self.generation:
                    return
                if self.window.open():
                    self.window.refresh(self.window.generation)
            except Exception as error:
                self.report([_lne_item('ui.open', _lne_error_name(error))])

        def OnSessionChanged(self, *args):
            try:
                if not self.current():
                    return
                character = getattr(self.session, 'charid', None)
                if character == self.character:
                    return
                self.window.close('session')
                self.generation += 1
                self.state = None
                self.character = character
                if character:
                    _lne_uthread.new(self.connect, self.generation)
            except Exception as error:
                print('LNE_BOARD_UI:ERROR:session:%s' % _lne_error_name(error))

        def OnDisconnect(self, *args):
            self.dispose()

    _lne_previous = getattr(_lne_builtins, _LNE_KEY, None)
    if _lne_previous is not None:
        try:
            _lne_previous.dispose()
        except Exception:
            pass
    _lne_owner = _LneBoardClient(_lne_context)
    setattr(_lne_builtins, _LNE_KEY, _lne_owner)
    _lne_uthread.new(_lne_owner.run)
    print('LNE_BOARD_UI:DELIVERED')
except Exception:
    print('LNE_BOARD_UI:UNAVAILABLE:DELIVERY')
