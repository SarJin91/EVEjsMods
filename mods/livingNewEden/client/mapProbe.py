try:
 import __builtin__ as _B
 import uthread as _U
 import blue as _L
 import hashlib as _H
 X=Exception
 G=getattr
 BUILDS = (3396210, 3724492)
 PROTO=1;SVC='lneMapSvc';KEY='__lne_map_probe_instance';MAX=64;WID='lneMapProbe1';CAP='LNE Map Probe'
 PR='carbonui.primitives.'
 WINS=(('eve','eve.client.script.ui.control.eveWindow'),('carbon','carbonui.control.window'))
 IMPS=('Fill','Line','VectorLine','Sprite','Transform','Frame','Container')
 MODS=('browser','corebrowserutil','eve.client.script.ui.browser')
 CFGS=('mapSystemCache','mapRegionCache','evelocations')
 SVCS=('starmap','viewState','neocom')
 SUBS=('Highlight','Color','Colour','Interest','Mark','Mode')
 COLS=((1,.3,.3,1),(.3,1,.3,1),(.3,.5,1,1),(1,.9,.3,1),(1,.4,1,1),(.3,1,1,1))
 _Z=lambda ms:_L.pyos.synchro.SleepWallclock(ms)
 def _P(t):print('LNE_MAP_UI:'+t)
 def _E(e):
  try:return type(e).__name__
  except X:return 'Exception'
 def _I(k,e=None):return ('p.'+k+('=1' if e is None else '=0:'+e))[:96]
 def _M(m,a=None):
  x=__import__(m,fromlist=[a or '__name__'])
  if a is None:return x
  v=G(x,a,None)
  if v is None:raise AttributeError(a)
  return v
 def _T(k,m,a=None):
  try:_M(m,a);return _I(k)
  except X as e:return _I(k,_E(e))
 def _W():
  for v,m in WINS:
   try:return v,_M(m,'Window')
   except X:pass
  return None,None
 def _N():
  f=G(G(_L,'os',None),'GetWallclockTime',None)
  if f is not None:return f()/10000.0
  import time
  return time.time()*1000.0
 def _S(sm,n):
  g=G(G(sm,'services',None),'get',None)
  if g is not None and g(n) is not None:return g(n)
  r=G(sm,'IsServiceRunning',None)
  if r is not None and r(n):return sm.GetService(n)
 def _A(o,a):
  try:
   f=G(o.__class__,a,None);c=G(G(f,'im_func',f),'func_code',None)
   return _H.sha256(c.co_code).hexdigest()[:8] if c is not None else 'v'
  except X:return 'v'
 class _C(object):
  __notifyevents__=['OnLneMapProbe','OnSessionChanged','OnDisconnect']
  def __init__(s,ctx):
   s.ctx=ctx;s.on=True;s.sm=s.ses=s.char=s.sd=s.win=None
   s.reg=[];s.gen=0;s.bn=0;s.done=set();s.q=[]
  def look(s,n):return s.ctx.get(n,G(_B,n,None))
  def cur(s):return s.on and G(_B,KEY,None) is s
  def close(s):
   w,s.win=s.win,None
   try:
    if w is not None:w.Close()
   except X:pass
  def dispose(s):
   s.on=False;s.gen+=1;s.close()
   for e in s.reg:
    try:s.sm.UnregisterForNotifyEvent(s,e)
    except X:pass
   s.reg=[]
  def rep(s,items):
   if s.sm is None:return
   for i in items:
    if i in s.done or i in s.q:continue
    if len(s.done)+len(s.q)>=MAX:break
    s.q.append(i)
   if s.q and s.sd!=s.gen:
    s.sd=s.gen
    try:_U.new(s.flush,s.gen)
    except X:s.sd=None
  def flush(s,g):
   n=0
   try:
    while s.q and s.cur() and g==s.gen:
     b=s.q[:MAX]
     r=s.sm.RemoteSvc(SVC).Report(PROTO,s.bn,b)
     if not s.cur() or g!=s.gen:return
     if isinstance(r,dict) and r.get('ok') is False:
      if r.get('reason')!='RATE_LIMIT' or n>=3:return
      n+=1
      try:t=int(r.get('retryMs'))
      except X:t=0
      _Z(min(max(t,1000),3600000));continue
     for i in b:
      s.done.add(i)
      if i in s.q:s.q.remove(i)
   except X:pass
   finally:
    if s.sd==g:s.sd=None
  def run(s):
   try:
    for i in range(240):
     if not s.cur():return
     s.sm=s.look('sm');s.ses=s.look('session')
     if s.sm is not None and s.ses is not None:break
     _Z(500)
    else:
     _P('UNAVAILABLE:WAIT');s.dispose();return
    try:b=int(G(s.look('boot'),'build',0))
    except X:b=0
    if b not in BUILDS:
     try:s.sm.RemoteSvc(SVC).Report(PROTO,max(0,b),['p.build=0:UNSUPPORTED_BUILD'])
     except X:pass
     _P('UNSUPPORTED_BUILD');s.dispose();return
    s.bn=b
    for e in s.__notifyevents__:
     s.sm.RegisterForNotifyEvent(s,e);s.reg.append(e)
    s.char=G(s.ses,'charid',None)
    if s.char:s.connect(s.gen)
   except X as e:_P('UNAVAILABLE:run:'+_E(e));s.dispose()
  def connect(s,g):
   try:
    it=s.probe()
    if not s.cur() or g!=s.gen:return
    s.done=set();s.q=[]
    s.rep(it+['p.ready=1']);_P('READY')
   except X as e:_P('UNAVAILABLE:connect:'+_E(e));s.dispose()
  def probe(s):
   it=[_T(a.lower().replace('ainer',''),PR+a.lower(),a) for a in IMPS]
   v,w=_W()
   it.append('p.win='+(v or '0:Absent'))
   it+=[_T(m,m) for m in MODS]
   c=s.look('cfg')
   it+=[_I('cfg.'+n,None if c is not None and hasattr(c,n) else 'Absent') for n in CFGS]
   for n in SVCS:
    try:it.append(_I(n,None if _S(s.sm,n) is not None else 'NotRunning'))
    except X as e:it.append(_I(n,_E(e)))
   return it
  def OnLneMapProbe(s,p=None,*a):
   try:
    if s.cur():_U.new(s.command,p,s.gen)
   except X as e:_P('ERROR:probe:'+_E(e))
  def command(s,p,g):
   try:
    if not s.cur() or g!=s.gen:return
    get=G(p,'get',None)
    m=get('mode') if get else None
    try:n=int(get('n'))
    except X:n=0
    s.done=set();s.q=[]
    if m=='attrs':s.rep(s.attrs())
    elif m=='nodes':s.nodes(max(1,min(n,5000)),g)
   except X as e:s.rep([_I('cmd',_E(e))])
  def attrs(s):
   it=[]
   for n in SVCS:
    try:v=_S(s.sm,n)
    except X:v=None
    if v is None:it.append(_I('a.'+n,'NotRunning'));continue
    d=[x for x in dir(v) if [t for t in SUBS if t in x]]
    it+=[('p.a.%s.%s=%s'%(n,x,_A(v,x)))[:96] for x in d[:40]]
    if len(d)>40:it.append('p.a.%s.trunc=%d'%(n,len(d)-40))
   return it
  def click(s):
   try:s.sm.GetService('info').ShowInfo(5,G(s.ses,'solarsystemid2',None));s.rep([_I('click')])
   except X as e:s.rep([_I('click',_E(e))])
  def nodes(s,n,g):
   it=['p.build.n=%d'%n];t0=_N()
   v,W=_W()
   if W is None:s.rep(it+['p.build.win=0:Absent']);return
   try:F=_M(PR+'fill','Fill')
   except X as e:s.rep(it+[_I('build.fill',_E(e))]);return
   L,ln=None,'none'
   for a in ('VectorLine','Line'):
    try:L,ln=_M(PR+a.lower(),a),a.lower();break
    except X:pass
   C=k=None
   try:C=_M(PR+'container','Container');k=_M('carbonui.uiconst')
   except X:pass
   tl,nrm=G(k,'TOPLEFT',None),G(k,'UI_NORMAL',None)
   s.close()
   cols=int(n**.5);cols+=cols*cols<n;z=cols*12+60
   try:
    try:w=W.Open(windowID=WID,caption=CAP,width=z,height=z)
    except TypeError:w=W.Open(windowID=WID,caption=CAP)
    s.win=w;body=G(w,'content',None)
    if body is None and hasattr(w,'GetMainArea'):body=w.GetMainArea()
    if body is None:body=G(G(w,'sr',None),'main',None)
    if C is not None and G(k,'TOALL',None) is not None:body=C(parent=body,align=k.TOALL)
   except X as e:s.rep(it+[_I('build.win',_E(e))]);return
   pos=lambda i:((i%cols)*12+10,(i//cols)*12+10)
   fe=ce=None;cl='NoAttr'
   for i in range(2*n-1):
    if i%100==99:
     _Z(0)
     if not s.cur() or g!=s.gen or s.win is not w:return
    if i<n:
     x,y=pos(i)
     kw=dict(left=x,top=y,width=6,height=6)
     if tl is not None:kw['align']=tl
     try:
      h=None
      if C is not None and nrm is not None:h=C(parent=body,state=nrm,**kw);kw=dict(kw,left=0,top=0)
      f=F(parent=body if h is None else h,**kw);t=f if h is None else h
      if hasattr(t,'OnClick'):t.OnClick=lambda *a:_U.new(s.click);cl=None
     except X as e:fe=_E(e);break
     try:f.color=COLS[i%6]
     except X as e:ce=ce or _E(e)
    elif L is not None:
     j=i-n;q=j+cols+1 if j+cols+1<n else j+1
     (a,b),(c,d)=pos(j),pos(q)
     try:
      if ln=='vectorline':L(parent=body,translationFrom=(a+3,b+3),translationTo=(c+3,d+3))
      else:L(parent=body,left=min(a,c)+3,top=min(b,d)+3,width=max(1,abs(c-a)),height=1)
     except X as e:ln='none:'+_E(e);L=None
   s.rep(it+['p.build.ms=%d'%int(_N()-t0),_I('build.fill',fe),'p.build.line='+ln,_I('build.color',ce),
    _I('click',cl) if cl else 'p.click.set=1'])
  def OnSessionChanged(s,*a):
   try:
    if not s.cur():return
    c=G(s.ses,'charid',None)
    if c==s.char:return
    s.close();s.gen+=1;s.char=c
    if c:_U.new(s.connect,s.gen)
   except X as e:_P('ERROR:session:'+_E(e))
  def OnDisconnect(s,*a):s.dispose()
 _p=G(_B,KEY,None)
 try:
  if _p is not None:_p.dispose()
 except X:pass
 _o=_C(_lne_context)
 setattr(_B,KEY,_o)
 _U.new(_o.run)
 _P('DELIVERED')
except Exception:
 print('LNE_MAP_UI:UNAVAILABLE:DELIVERY')
