try:
  import __builtin__ as _lne_builtins
  import uthread as _lne_uthread
  import blue as _lne_blue

  PROTO = 1
  WIRE = 1
  BUILDS = (3396210, 3724492)
  SVC = 'lneMapSvc'
  NOTIFY_OPEN = 'OnLneMapOpen'
  MAX_REPORT_ITEMS = 64
  MAX_REPORT_ITEM_CHARS = 96

  _LNE_KEY = '__lne_map_instance'
  _LNE_WAIT_STEPS = 240
  _LNE_WAIT_MS = 500

  WINDOW_ID = 'lneMapWindow1'
  CAPTION = 'LNE Map'
  _LNE_DEFAULT_SIZE = (640, 560)
  _LNE_MIN_SIZE = (420, 360)
  _LNE_BAR_HEIGHT = 24
  _LNE_LINE_HEIGHT = 18
  _LNE_GAP = 4
  _LNE_LIST_WIDTH = 150
  _LNE_NODE = 7
  _LNE_MARK = 4
  _LNE_PAD = 12
  _LNE_XY_MAX = 1000
  _LNE_FALLBACK_SIDE = 600
  _LNE_EXT_ALPHA = 0.45
  _LNE_CHUNK = 100
  _LNE_STEP_MS = 500
  _LNE_MIN_POLL_MS = 10000
  _LNE_DEFAULT_POLL_MS = 30000
  _LNE_DEFAULT_CACHE = 8
  _LNE_DEFAULT_LABELS = 150
  _LNE_NAME_CHARS = 32
  _LNE_MAX_REPORTED = 64
  _LNE_REPORT_RETRIES = 3
  _LNE_RETRY_MS = (1000, 3600000)
  _LNE_SOLAR_SYSTEM_TYPE = 5
  _LNE_FL_STATE = 7
  _LNE_FRAMED = (2, 3, 4)
  _LNE_SEC_HEX = ('f00000', 'd73000', 'f04800', 'f06000', 'd77700', 'efef00', '8fef2f', '00f000', '00ef47',
                  '48f0c0', '2fefef')
  _LNE_NULL_SEC_HEX = '8a1010'
  _LNE_FRAME_COLOR = (1.0, 1.0, 1.0, 0.85)
  _LNE_EDGE_COLOR = (0.55, 0.6, 0.7, 0.5)
  _LNE_DIM_COLOR = (0.85, 0.7, 0.45, 0.8)

  _LNE_WINDOW_CLASSES = (
    ('eve', 'eve.client.script.ui.control.eveWindow', 'Window'),
    ('carbon', 'carbonui.control.window', 'Window'),
  )
  _LNE_BUTTON_CLASSES = (
    ('eve', 'eve.client.script.ui.control.buttons', 'Button'),
    ('carbon', 'carbonui.control.button', 'Button'),
  )
  _LNE_SCROLL_CLASSES = (('carbon', 'carbonui.control.scrollContainer', 'ScrollContainer'),)
  _LNE_CONT_CLASSES = (('carbon', 'carbonui.primitives.container', 'Container'),)
  _LNE_LABEL_CLASSES = (
    ('eve', 'eve.client.script.ui.control.eveLabel', 'EveLabelSmall'),
    ('carbon', 'carbonui.control.label', 'Label'),
  )
  _LNE_FILL_CLASSES = (('fill', 'carbonui.primitives.fill', 'Fill'),)
  _LNE_LINE_CLASSES = (('vectorline', 'carbonui.primitives.vectorline', 'VectorLine'),)
  _LNE_FRAME_CLASSES = (('frame', 'carbonui.primitives.frame', 'Frame'),)
  _LNE_CONST_MODULES = ('carbonui.uiconst', 'carbonui.const')
  _LNE_NODE_LADDER = (('fill', _LNE_FILL_CLASSES), ('label', _LNE_LABEL_CLASSES), ('none', None))
  _LNE_EDGE_LADDER = (('vectorline', _LNE_LINE_CLASSES), ('none', None))
  _LNE_ACTIONS = (('route', 'starmap', 'SetWaypoint'), ('info', 'info', 'ShowInfo'))

  def _lne_item(key, error):
    text = key + '=1' if error is None else key + '=0:' + error
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

  def _lne_list(data, key):
    value = data.get(key) if isinstance(data, dict) else None
    return list(value) if isinstance(value, (list, tuple)) else []

  def _lne_row(value, size):
    row = list(value) if isinstance(value, (list, tuple)) else []
    return row if len(row) >= size else None

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

  def _lne_rungs(ladder, after):
    out = []
    seen = after is None
    for rung, table in ladder:
      if not seen:
        seen = rung == after
      elif table is None or _lne_pick(table)[1] is not None:
        out.append(rung)
    return out

  def _lne_uiconst():
    for module in _LNE_CONST_MODULES:
      try:
        loaded = __import__(module, fromlist=['TOTOP'])
      except Exception:
        continue
      if hasattr(loaded, 'TOTOP'):
        return loaded
    raise NoConst()

  def _lne_now():
    clock = getattr(getattr(_lne_blue, 'os', None), 'GetWallclockTime', None)
    if clock is not None:
      return clock() / 10000.0
    import time
    return time.time() * 1000.0

  def _lne_rgb(r, g, b, alpha):
    return (_lne_int(r) / 255.0, _lne_int(g) / 255.0, _lne_int(b) / 255.0, alpha)

  def _lne_hex(text, alpha):
    value = int(text, 16)
    return _lne_rgb((value >> 16) & 255, (value >> 8) & 255, value & 255, alpha)

  def _lne_sec_color(tenths, alpha):
    tenths = _lne_int(tenths)
    if tenths < 0:
      return _lne_hex(_LNE_NULL_SEC_HEX, alpha)
    return _lne_hex(_LNE_SEC_HEX[min(len(_LNE_SEC_HEX) - 1, tenths)], alpha)

  def _lne_markup(color, text):
    a, r, g, b = [int(max(0.0, min(1.0, c)) * 255) for c in (color[3], color[0], color[1], color[2])]
    return '<color=0x%02X%02X%02X%02X>%s</color>' % (a, r, g, b, text)

  class NoClass(Exception):
    pass

  class NoParent(Exception):
    pass

  class NoWindow(Exception):
    pass

  class NoConst(Exception):
    pass

  class Stale(Exception):
    pass

  class _LneMapWindow(object):

    def __init__(self, owner):
      self.owner = owner
      self.win = self.cls = self.const = None
      self.body = self.mid = self.canvas = self.list = self.panel = self.status = None
      self.classes = {}
      self.generation = 0
      self.build_no = 0
      self.made = 0
      self.busy = False
      self.note = ''
      self.step = 'open'
      self.wait_until = 0
      self.pending = self.again = False
      self.node_rung = self.edge_rung = 'none'
      self.click_rung = 'list'
      self.frame_ok = False
      self.reset()

    def reset(self):
      self.cache = {}
      self.order = []
      self.states = {}
      self.ui = {}
      self.view = ('here', 0)
      self.current = self.drawn = self.sel = None
      self.trunc = {}

    def make(self, kind, candidates):
      found = self.classes.get(kind)
      if found is None:
        found = _lne_pick(candidates)[1]
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

    def empty(self, cont):
      flush = getattr(cont, 'Flush', None)
      if flush is not None:
        flush()
        return
      for child in list(getattr(cont, 'children', None) or ()):
        child.Close()

    def find_parent(self, win):
      content = getattr(win, 'content', None)
      if content is not None:
        return content
      main_area = getattr(win, 'GetMainArea', None)
      found = main_area() if main_area is not None else None
      if found is None:
        found = getattr(getattr(win, 'sr', None), 'main', None)
      if found is None:
        raise NoParent()
      return found

    def create(self, cls):
      if hasattr(cls, 'Open'):
        try:
          win = cls.Open(windowID=WINDOW_ID, caption=CAPTION, minSize=_LNE_MIN_SIZE, width=_LNE_DEFAULT_SIZE[0],
                         height=_LNE_DEFAULT_SIZE[1])
        except TypeError:
          win = cls.Open(windowID=WINDOW_ID, caption=CAPTION)
        if win is None and hasattr(cls, 'GetIfOpen'):
          win = cls.GetIfOpen(windowID=WINDOW_ID)
      else:
        win = cls(windowID=WINDOW_ID, caption=CAPTION)
      if win is None:
        raise NoWindow()
      return win

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
      if self.win is not None and not self.player_closed():
        return True
      self.close('reopen')
      generation = self.generation
      self.step = 'class'
      try:
        cls = _lne_pick(_LNE_WINDOW_CLASSES)[1]
        if cls is None:
          raise NoClass()
        self.cls = cls
        try:
          getter = getattr(cls, 'GetIfOpen', None)
          old = getter(windowID=WINDOW_ID) if getter is not None else None
          if old is not None:
            old.Close()
        except Exception as error:
          items.append(_lne_item('m.ui.close', _lne_error_name(error)))
        self.step = 'window'
        self.win = self.create(cls)
        self.step = 'parent'
        parent = self.find_parent(self.win)
        self.const = _lne_uiconst()
        self.layout(parent)
      except Exception as error:
        items.append(_lne_item('m.ui.' + self.step, _lne_error_name(error)))
        self.close('build')
        self.owner.report(items)
        return False
      self.owner.report(items)
      _lne_uthread.new(self.loop, generation)
      return True

    def close(self, where):
      win = self.win
      cls = self.cls
      self.generation += 1
      self.win = None
      self.body = self.mid = self.canvas = self.list = self.panel = self.status = None
      self.busy = False
      self.drawn = None
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
        self.owner.report([_lne_item('m.ui.close', _lne_error_name(error))])

    def fail(self, error, generation):
      self.owner.report([_lne_item('m.ui.' + self.step, _lne_error_name(error))])
      if generation == self.generation:
        self.close('error')

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
          if (self.pending or waited >= self.poll_ms()) and _lne_now() >= self.wait_until:
            waited = 0
            self.refresh(generation)
      except Exception as error:
        self.step = 'loop'
        self.fail(error, generation)

    def poll_ms(self):
      poll = _lne_int(self.ui.get('pollMs'))
      return max(_LNE_MIN_POLL_MS, poll if poll > 0 else _LNE_DEFAULT_POLL_MS)

    def known(self, scope, ident):
      if scope == 'here':
        return '', ''
      entry = self.cache.get((scope, ident))
      state = self.states.get((scope, ident))
      return (entry[0] if entry else ''), (state[0] if state else '')

    def remember(self, key, sk, static):
      self.cache[key] = (sk, static)
      if key in self.order:
        self.order.remove(key)
      self.order.append(key)
      limit = max(1, _lne_int(self.ui.get('cacheRegions')) or _LNE_DEFAULT_CACHE)
      while len(self.order) > limit:
        old = self.order.pop(0)
        self.cache.pop(old, None)
        self.states.pop(old, None)

    def take(self, data):
      key = ('%s' % data.get('scope'), _lne_int(data.get('id')))
      sk = '%s' % data.get('sk')
      st = '%s' % data.get('st')
      if isinstance(data.get('ui'), dict):
        self.ui = data.get('ui')
      if isinstance(data.get('static'), dict):
        self.remember(key, sk, data.get('static'))
      if isinstance(data.get('state'), dict):
        self.states[key] = (st, data.get('state'))
      self.trunc = data.get('trunc') if isinstance(data.get('trunc'), dict) else {}
      entry = self.cache.get(key)
      state = self.states.get(key)
      missing = (entry is None or entry[0] != sk, state is None or state[0] != st)
      if missing == (False, False):
        self.current = (key, sk, st)
      return key, missing

    def ask(self, scope, ident, known_static, known_state):
      try:
        return self.owner.sm.RemoteSvc(SVC).GetMap(PROTO, scope, ident, known_static, known_state)
      except Exception as error:
        self.note = 'server unreachable'
        self.owner.report([_lne_item('m.ui.get', _lne_error_name(error))])
        return None

    def refresh(self, generation=None):
      if generation is None:
        generation = self.generation
      if self.busy or not self.alive(generation):
        self.pending = True
        return
      self.busy = True
      self.pending = False
      try:
        view = self.view
        data = self.ask(view[0], view[1], *self.known(view[0], view[1]))
        if not self.alive(generation):
          return
        if self.view != view:
          self.pending = True
        elif isinstance(data, dict):
          if data.get('ok') is False:
            reason = '%s' % (data.get('reason') or 'refused')
            if reason in ('RATE_LIMIT', 'BUSY'):
              wait = min(max(_lne_int(data.get('retryMs')), _LNE_RETRY_MS[0]), _LNE_RETRY_MS[1])
              self.wait_until = _lne_now() + wait
              self.pending = True
            self.note = reason.lower().replace('_', ' ')
          elif data.get('v') != WIRE:
            self.note = 'other version'
            self.owner.report([_lne_item('m.ui.wire', 'Mismatch')])
          else:
            key, missing = self.take(data)
            self.view = key
            self.note = 'no data' if True in missing else ''
            if True in missing:
              self.cache.pop(key, None)
              self.states.pop(key, None)
              self.pending = not self.again
            self.again = True in missing
        self.render(generation)
      finally:
        if generation == self.generation:
          self.busy = False

    def go(self, scope, ident):
      def handler(*args, **kw):
        self.view = (scope, ident)
        self.sel = None
        _lne_uthread.new(self.refresh, self.generation)
      return handler

    def action(self, key, service, method, *args, **kw):
      try:
        getattr(self.owner.sm.GetService(service), method)(*args, **kw)
      except TypeError:
        try:
          getattr(self.owner.sm.GetService(service), method)(*args)
        except Exception as error:
          self.owner.report([_lne_item('m.act.' + key, _lne_error_name(error))])
      except Exception as error:
        self.owner.report([_lne_item('m.act.' + key, _lne_error_name(error))])

    def route_handler(self, system_id):
      return lambda *a, **k: self.action('route', 'starmap', 'SetWaypoint', system_id, clearOtherWaypoints=True)

    def info_handler(self, system_id):
      return lambda *a, **k: self.action('info', 'info', 'ShowInfo', _LNE_SOLAR_SYSTEM_TYPE, system_id)

    def select_handler(self, index):
      return lambda *a, **k: _lne_uthread.new(self.select, index, self.generation)

    def layout(self, parent):
      const = self.const
      cont = self.make('cont', _LNE_CONT_CLASSES)
      button = self.make('button', _LNE_BUTTON_CLASSES)
      label = self.make('label', _LNE_LABEL_CLASSES)
      self.step = 'layout'
      self.body = cont(parent=parent, align=const.TOALL)
      bar = self.place(cont, {'padBottom': _LNE_GAP}, parent=self.body, align=const.TOTOP, height=_LNE_BAR_HEIGHT)
      for text, func in (('Galaxy', self.go('galaxy', 0)), ('Here', self.go('here', 0)),
                         ('Refresh', lambda *a, **k: _lne_uthread.new(self.refresh, self.generation))):
        self.place(button, {'padRight': _LNE_GAP}, parent=bar, label=text, func=func, align=const.TOLEFT)
      box = self.place(cont, {'clipChildren': True}, parent=bar, align=const.TOALL)
      self.status = label(parent=box, text='Loading...', align=const.TOLEFT)
      self.panel = self.place(cont, {'padTop': _LNE_GAP}, parent=self.body, align=const.TOBOTTOM,
                              height=_LNE_LINE_HEIGHT + _LNE_BAR_HEIGHT)
      self.mid = cont(parent=self.body, align=const.TOALL)
      if self.click_rung == 'list' or self.node_rung == 'none':
        scroll = _lne_pick(_LNE_SCROLL_CLASSES)[1]
        try:
          self.list = scroll(parent=self.mid, align=const.TORIGHT, width=_LNE_LIST_WIDTH) if scroll else None
        except Exception:
          self.list = None
        if self.list is None:
          self.list = cont(parent=self.mid, align=const.TORIGHT, width=_LNE_LIST_WIDTH)
      self.canvas = self.place(cont, {'clipChildren': True}, parent=self.mid, align=const.TOALL)

    def reset_canvas(self):
      if self.list is not None:
        self.empty(self.list)
      if getattr(self.canvas, 'Flush', None) is not None:
        self.canvas.Flush()
        return
      self.canvas.Close()
      self.canvas = self.place(self.make('cont', _LNE_CONT_CLASSES), {'clipChildren': True}, parent=self.mid,
                               align=self.const.TOALL)

    def side(self):
      getter = getattr(self.canvas, 'GetAbsoluteSize', None)
      try:
        size = getter()
        width, height = _lne_int(size[-2]), _lne_int(size[-1])
      except Exception:
        width = height = 0
      if width <= 0 or height <= 0:
        return _LNE_FALLBACK_SIDE
      return min(width, height)

    def tick(self, generation, build_no):
      self.made += 1
      if self.made % _LNE_CHUNK == 0:
        _lne_blue.pyos.synchro.SleepWallclock(0)
        if not self.alive(generation) or build_no != self.build_no:
          raise Stale()

    def render(self, generation):
      if not self.alive(generation):
        return
      try:
        if self.current is not None and self.current != self.drawn:
          self.draw(generation)
        self.show_status()
      except Stale:
        return
      except Exception as error:
        self.fail(error, generation)

    def data(self):
      key = self.current[0]
      entry = self.cache.get(key)
      state = self.states.get(key)
      return key, (entry[1] if entry else {}), (state[1] if state else {})

    def show_status(self):
      if self.status is None:
        return
      text = 'Loading...'
      if self.current is not None:
        key, static, state = self.data()
        text = '%s, %d nodes' % (self.scope_name(key), len(_lne_list(static, 'ids')))
        if _lne_int(self.trunc.get('sys')) > 0:
          text += ', trunc %d' % _lne_int(self.trunc.get('sys'))
        if _lne_list(state, 'miss'):
          text += ', partial'
      if self.note:
        text += ' - %s' % self.note
      try:
        self.status.text = text
      except Exception:
        pass

    def scope_name(self, key):
      if key[0] == 'galaxy':
        return 'Galaxy'
      galaxy = self.cache.get(('galaxy', 0))
      ids = _lne_list(galaxy[1], 'ids') if galaxy else []
      names = _lne_list(galaxy[1], 'nm') if galaxy else []
      if key[1] in ids and ids.index(key[1]) < len(names):
        return _lne_text(names[ids.index(key[1])], _LNE_NAME_CHARS)
      return 'Region %d' % key[1]

    def color_of(self, index, own, fac, sec, ext):
      alpha = _LNE_EXT_ALPHA if index in ext else 1.0
      owner = _lne_int(own[index]) if index < len(own) else -1
      row = _lne_row(fac[owner], 5) if 0 <= owner < len(fac) else None
      if row is not None:
        return _lne_rgb(row[2], row[3], row[4], alpha)
      return _lne_sec_color(sec[index] if index < len(sec) else -1, alpha)

    def draw(self, generation):
      self.build_no += 1
      build_no = self.build_no
      self.made = 0
      self.drawn = None
      self.step = 'draw'
      key, static, state = self.data()
      const = self.const
      cont = self.make('cont', _LNE_CONT_CLASSES)
      self.reset_canvas()
      ids = _lne_list(static, 'ids')
      xy = _lne_list(static, 'xy')
      names = _lne_list(static, 'nm')
      sec = _lne_list(static, 'sec')
      ext = set(_lne_int(i) for i in _lne_list(static, 'ext'))
      own = _lne_list(state, 'own')
      fac = _lne_list(state, 'fac')
      flags = _lne_list(state, 'fl')
      region = key[0] == 'region'
      usable = max(1, self.side() - 2 * _LNE_PAD)
      points = []
      for i in range(len(ids)):
        x = _lne_int(xy[2 * i]) if 2 * i < len(xy) else 0
        y = _lne_int(xy[2 * i + 1]) if 2 * i + 1 < len(xy) else 0
        points.append((_LNE_PAD + x * usable // _LNE_XY_MAX, _LNE_PAD + y * usable // _LNE_XY_MAX))
      self.step = 'edge'
      edges = _lne_list(static, 'ed')
      for j in range(0, len(edges) - 1, 2):
        a, b = _lne_int(edges[j]), _lne_int(edges[j + 1])
        if 0 <= a < len(points) and 0 <= b < len(points):
          if not self.edge(points[a], points[b]):
            break
          self.tick(generation, build_no)
      self.step = 'node'
      labels = region and len(ids) <= _lne_int(self.ui.get('maxLabels', _LNE_DEFAULT_LABELS))
      label = self.make('label', _LNE_LABEL_CLASSES)
      normal = getattr(const, 'UI_NORMAL', None)
      for i in range(len(points)):
        x, y = points[i]
        holder = self.place(cont, {'state': normal} if self.click_rung == 'onclick' else None, parent=self.canvas,
                            align=const.TOPLEFT, left=x - _LNE_NODE // 2, top=y - _LNE_NODE // 2, width=_LNE_NODE,
                            height=_LNE_NODE)
        self.node(holder, x, y, self.color_of(i, own, fac, sec, ext))
        if region and i < len(flags) and (_lne_int(flags[i]) & _LNE_FL_STATE) in _LNE_FRAMED:
          self.frame(holder)
        if self.click_rung == 'onclick':
          try:
            holder.OnClick = self.select_handler(i)
          except Exception as error:
            self.click_rung = 'list'
            self.owner.report(['m.click=list', _lne_item('m.click.onclick', _lne_error_name(error))])
        if labels and i < len(names):
          label(parent=self.canvas, align=const.TOPLEFT, left=x + _LNE_NODE, top=y - _LNE_NODE,
                text=_lne_text(names[i], _LNE_NAME_CHARS))
        self.tick(generation, build_no)
      self.step = 'mark'
      self.marks(state, points, generation, build_no)
      if self.list is not None:
        self.step = 'list'
        button = self.make('button', _LNE_BUTTON_CLASSES)
        for i in range(len(names)):
          self.place(button, {'padBottom': 1}, parent=self.list, align=const.TOTOP, label=_lne_text(names[i], 20),
                     func=self.select_handler(i))
          self.tick(generation, build_no)
      self.drawn = self.current
      if self.sel is None or self.sel >= len(ids):
        self.sel = None
      self.show_panel()

    def node(self, holder, x, y, color):
      while self.node_rung != 'none':
        try:
          if self.node_rung == 'fill':
            self.make('fill', _LNE_FILL_CLASSES)(parent=holder, align=self.const.TOALL, color=color)
          else:
            self.make('label', _LNE_LABEL_CLASSES)(parent=self.canvas, align=self.const.TOPLEFT,
                                                   left=x - _LNE_NODE // 2, top=y - _LNE_NODE,
                                                   text=_lne_markup(color, '*'))
          return
        except Exception as error:
          old = self.node_rung
          self.node_rung = (_lne_rungs(_LNE_NODE_LADDER, old) or ['none'])[0]
          self.owner.report([_lne_item('m.node.' + old, _lne_error_name(error)), 'm.node=' + self.node_rung])

    def edge(self, a, b):
      if self.edge_rung != 'vectorline':
        return False
      try:
        self.place(self.make('line', _LNE_LINE_CLASSES), {'colorFrom': _LNE_EDGE_COLOR, 'colorTo': _LNE_EDGE_COLOR},
                   parent=self.canvas, translationFrom=a, translationTo=b, widthFrom=1, widthTo=1)
        return True
      except Exception as error:
        self.edge_rung = 'none'
        self.owner.report([_lne_item('m.edge.vectorline', _lne_error_name(error)), 'm.edge=none'])
        return False

    def frame(self, holder):
      if not self.frame_ok:
        return
      try:
        self.make('frame', _LNE_FRAME_CLASSES)(parent=holder, color=_LNE_FRAME_COLOR)
      except Exception as error:
        self.frame_ok = False
        self.owner.report([_lne_item('m.frame', _lne_error_name(error))])

    def marks(self, state, points, generation, build_no):
      const = self.const
      slots = {}
      for row in _lne_list(state, 'mkl'):
        row = _lne_row(row, 5)
        if row is not None:
          slots[_lne_int(row[0])] = (len(slots), _lne_rgb(row[2], row[3], row[4], 1.0))
      if self.node_rung == 'none' or not slots:
        return
      label = self.make('label', _LNE_LABEL_CLASSES)
      for row in _lne_list(state, 'mk'):
        row = _lne_row(row, 3)
        if row is None or _lne_int(row[0]) not in slots or not 0 <= _lne_int(row[1]) < len(points):
          continue
        slot, color = slots[_lne_int(row[0])]
        x, y = points[_lne_int(row[1])]
        left = x + _LNE_NODE // 2 + 1 + slot * (_LNE_MARK + 1)
        top = y + _LNE_NODE // 2 + 1
        if self.node_rung == 'fill':
          self.make('fill', _LNE_FILL_CLASSES)(parent=self.canvas, align=const.TOPLEFT, left=left, top=top,
                                               width=_LNE_MARK, height=_LNE_MARK, color=color)
        else:
          label(parent=self.canvas, align=const.TOPLEFT, left=left, top=top, text=_lne_markup(color, '#'))
        if _lne_int(row[2]) > 1:
          label(parent=self.canvas, align=const.TOPLEFT, left=left, top=top + _LNE_MARK, text='%d' % _lne_int(row[2]))
        self.tick(generation, build_no)

    def select(self, index, generation):
      if not self.alive(generation):
        return
      try:
        self.sel = index
        self.show_panel()
      except Exception as error:
        self.step = 'select'
        self.fail(error, generation)

    def show_panel(self):
      const = self.const
      if self.panel is None or self.current is None:
        return
      cont = self.make('cont', _LNE_CONT_CLASSES)
      button = self.make('button', _LNE_BUTTON_CLASSES)
      label = self.make('label', _LNE_LABEL_CLASSES)
      self.empty(self.panel)
      key, static, state = self.data()
      ids = _lne_list(static, 'ids')
      index = self.sel
      line = cont(parent=self.panel, align=const.TOTOP, height=_LNE_LINE_HEIGHT)
      if index is None or index >= len(ids):
        self.place(label, {'color': _LNE_DIM_COLOR}, parent=line, align=const.TOLEFT,
                   text='Click a node' if self.click_rung == 'onclick' else 'Pick a node in the list')
        return
      names = _lne_list(static, 'nm')
      sec = _lne_list(static, 'sec')
      own = _lne_list(state, 'own')
      fac = _lne_list(state, 'fac')
      owner = _lne_int(own[index]) if index < len(own) else -1
      row = _lne_row(fac[owner], 2) if 0 <= owner < len(fac) else None
      faction = _lne_text(row[1], _LNE_NAME_CHARS) if row is not None else 'no controller'
      label(parent=line, align=const.TOLEFT, text='%s  sec %.1f  %s' % (
        _lne_text(names[index] if index < len(names) else '?', _LNE_NAME_CHARS),
        _lne_int(sec[index] if index < len(sec) else 0) / 10.0, faction))
      bottom = cont(parent=self.panel, align=const.TOTOP, height=_LNE_BAR_HEIGHT)
      target = _lne_int(ids[index])
      buttons = [('Open region', self.go('region', target))] if key[0] == 'galaxy' else []
      if key[0] != 'galaxy' and self.owner.available.get('info'):
        buttons.append(('Info', self.info_handler(target)))
      if key[0] != 'galaxy' and self.owner.available.get('route'):
        buttons.append(('Route', self.route_handler(target)))
      for text, func in buttons:
        self.place(button, {'padRight': _LNE_GAP}, parent=bottom, align=const.TOLEFT, label=text, func=func)

  class _LneMapClient(object):
    __notifyevents__ = [NOTIFY_OPEN, 'OnSessionChanged', 'OnDisconnect']

    def __init__(self, context):
      self.context = context
      self.active = True
      self.client_no = 0
      self.sm = self.session = self.character = self.sender = None
      self.registered = []
      self.generation = 0
      self.available = {}
      self.reported = set()
      self.queued = []
      self.window = _LneMapWindow(self)

    def lookup(self, name):
      return self.context.get(name, getattr(_lne_builtins, name, None))

    def current(self):
      return self.active and getattr(_lne_builtins, _LNE_KEY, None) is self

    def dispose(self):
      self.active = False
      try:
        self.window.close('dispose')
      except Exception:
        pass
      self.generation += 1
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
            _lne_blue.pyos.synchro.SleepWallclock(min(max(_lne_int(answer.get('retryMs')), _LNE_RETRY_MS[0]),
                                                      _LNE_RETRY_MS[1]))
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
      print('LNE_MAP_UI:UNAVAILABLE:%s:%s' % (where, _lne_error_name(error)))
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
          print('LNE_MAP_UI:UNAVAILABLE:WAIT')
          self.dispose()
          return
        try:
          build = int(getattr(self.lookup('boot'), 'build', 0))
        except Exception:
          build = 0
        if build not in BUILDS:
          try:
            self.sm.RemoteSvc(SVC).Report(PROTO, max(0, build), ['m.build=0:UNSUPPORTED_BUILD'])
          except Exception:
            pass
          print('LNE_MAP_UI:UNSUPPORTED_BUILD')
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
        self.report(items[:MAX_REPORT_ITEMS - 1] + ['m.ready=1'])
        print('LNE_MAP_UI:MAP_READY')
      except Exception as error:
        self.fail(error, 'connect')

    def probe(self):
      items = []
      window = self.window
      for key, candidates in (('win', _LNE_WINDOW_CLASSES), ('button', _LNE_BUTTON_CLASSES),
                              ('label', _LNE_LABEL_CLASSES), ('cont', _LNE_CONT_CLASSES),
                              ('scroll', _LNE_SCROLL_CLASSES), ('frame', _LNE_FRAME_CLASSES)):
        variant, found = _lne_pick(candidates)
        items.append('m.%s=%s' % (key, variant) if found is not None else _lne_item('m.' + key, 'Absent'))
        if key == 'frame':
          window.frame_ok = found is not None
      window.node_rung = (_lne_rungs(_LNE_NODE_LADDER, None) or ['none'])[0]
      window.edge_rung = (_lne_rungs(_LNE_EDGE_LADDER, None) or ['none'])[0]
      try:
        normal = getattr(_lne_uiconst(), 'UI_NORMAL', None)
      except Exception:
        normal = None
      onclick = normal is not None and _lne_pick(_LNE_CONT_CLASSES)[1] is not None
      window.click_rung = 'onclick' if onclick else 'list'
      items += ['m.node=' + window.node_rung, 'm.edge=' + window.edge_rung, 'm.click=' + window.click_rung]
      available = {}
      for key, service, method in _LNE_ACTIONS:
        error = None
        try:
          if not hasattr(self.sm.GetService(service), method):
            error = 'NoAttr'
        except Exception as exc:
          error = _lne_error_name(exc)
        available[key] = error is None
        items.append(_lne_item('m.act.' + key, error))
      self.available = available
      return items

    def OnLneMapOpen(self, payload=None, *args):
      try:
        if self.current():
          _lne_uthread.new(self.open_window, self.generation)
      except Exception as error:
        print('LNE_MAP_UI:ERROR:open:%s' % _lne_error_name(error))

    def open_window(self, generation):
      try:
        if not self.current() or generation != self.generation:
          return
        window = self.window
        if window.open():
          window.view = ('here', 0)
          window.sel = None
          window.refresh(window.generation)
      except Exception as error:
        self.report([_lne_item('m.ui.open', _lne_error_name(error))])

    def OnSessionChanged(self, *args):
      try:
        if not self.current():
          return
        character = getattr(self.session, 'charid', None)
        if character == self.character:
          return
        self.window.close('session')
        self.window.reset()
        self.generation += 1
        self.character = character
        if character:
          _lne_uthread.new(self.connect, self.generation)
      except Exception as error:
        print('LNE_MAP_UI:ERROR:session:%s' % _lne_error_name(error))

    def OnDisconnect(self, *args):
      self.dispose()

  _lne_previous = getattr(_lne_builtins, _LNE_KEY, None)
  if _lne_previous is not None:
    try:
      _lne_previous.dispose()
    except Exception:
      pass
  _lne_owner = _LneMapClient(_lne_context)
  setattr(_lne_builtins, _LNE_KEY, _lne_owner)
  _lne_uthread.new(_lne_owner.run)
  print('LNE_MAP_UI:DELIVERED')
except Exception:
  print('LNE_MAP_UI:UNAVAILABLE:DELIVERY')
