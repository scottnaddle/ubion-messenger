import json,subprocess,http.cookiejar,urllib.request,os
B="https://coco.ubion.co.kr"
cj=http.cookiejar.MozillaCookieJar("/tmp/daoumsg/jar.txt")
if os.path.exists(cj.filename): cj.load(ignore_discard=True,ignore_expires=True)
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.addheaders=[("User-Agent","Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36"),("X-Requested-With","XMLHttpRequest")]
def get(p,**kw):
    try:
        r=op.open(urllib.request.Request(B+p,**kw)); return r.status,r.read(),r.headers
    except urllib.error.HTTPError as e: return e.code,e.read(),e.headers
def login():
    pw=subprocess.check_output(["security","find-generic-password","-a","cwdaddy","-s","daou-coco","-w"]).decode().strip()
    s,b,h=get("/api/login",data=json.dumps({"username":"cwdaddy","password":pw,"captcha":"","returnUrl":""}).encode(),headers={"Content-Type":"application/json"})
    cj.save(ignore_discard=True,ignore_expires=True); return s,b,h
def ensure():
    s,_,_=get("/api/user/session")
    if s!=200: print("login:",login()[0]); 
    cj.save(ignore_discard=True,ignore_expires=True)
