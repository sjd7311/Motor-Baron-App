#!/usr/bin/env python3
"""Creates Motor Baron's Game Center achievements and leaderboards in App Store Connect.

Reads the achievement list straight from the game file, draws a medal image for each,
and creates or updates them through the App Store Connect API. Safe to run again:
achievements that already exist are updated, not duplicated.

Needs: APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_KEY_IDENTIFIER,
APP_STORE_CONNECT_PRIVATE_KEY (the text of the .p8 file), and BUNDLE_ID.
"""
import hashlib, io, json, os, re, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = HERE if os.path.exists(os.path.join(HERE, 'package.json')) else os.path.dirname(HERE)
PREFIX = 'motorbaron.'
API = 'https://api.appstoreconnect.apple.com/v1'


def find_game():
    for p in ('src/game.html', 'game.html'):
        f = os.path.join(ROOT, p)
        if os.path.exists(f):
            return f
    sys.exit('Could not find game.html')


def read_leaderboards(path):
    s = open(path, encoding='utf-8').read()
    if 'const LBS=[' not in s:
        return []
    start = s.index('const LBS=[')
    block = s[start:s.index('];', start)]
    return [{'id': a, 'name': n, 'fmt': f} for a, n, f in re.findall(r"\{id:'(\w+)',name:'([^']+)',fmt:'(\w+)'\}", block)]


def read_achievements(path):
    s = open(path, encoding='utf-8').read()
    start = s.index('const ACH=[')
    block = s[start:s.index('];', start)]
    rows = re.findall(r"\{id:'(\w+)',pts:(\d+),name:(['\"])(.*?)\3,d:(['\"])(.*?)\5", block)
    out = []
    for aid, pts, _, name, _, d in rows:
        out.append({'id': aid, 'pts': int(pts), 'name': name.replace("\\'", "'"), 'd': d.replace("\\'", "'")})
    total = sum(a['pts'] for a in out)
    if total > 1000:
        sys.exit(f'Achievement points add up to {total}; Game Center allows 1,000.')
    return out


# ---------- medal images ----------
def font(size):
    from PIL import ImageFont
    for f in ('/System/Library/Fonts/Supplemental/Georgia Bold.ttf', '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default(size=size)


_ART = None
def art_png(a):
    """Drawn medal for this achievement from achievement-art.zip (made from the game's own drawings), or None."""
    global _ART
    if _ART is None:
        import zipfile
        _ART = {}
        here = os.path.dirname(os.path.abspath(__file__))
        for p in (os.path.join(here, '..', 'achievement-art.zip'), os.path.join(here, '..', 'resources', 'achievement-art.zip'), os.path.join(here, 'achievement-art.zip'), 'achievement-art.zip'):
            if os.path.exists(p):
                with zipfile.ZipFile(p) as z:
                    for n in z.namelist():
                        if n.endswith('.png'):
                            _ART[os.path.basename(n)[:-4]] = z.read(n)
                print(f'Using {len(_ART)} drawn medal images from {p}')
                break
    return _ART.get(a['id'])


def medal_png(a):
    from PIL import Image, ImageDraw
    S = 1024
    tiers = [(15, ((205, 127, 50), (240, 180, 120))), (30, ((168, 169, 173), (230, 231, 235))), (999, ((201, 162, 39), (246, 222, 140)))]
    dark, light = next(c for lim, c in tiers if a['pts'] < lim)
    im = Image.new('RGB', (S, S), (29, 88, 66))
    d = ImageDraw.Draw(im)
    c = S // 2
    for r, col in ((440, (20, 60, 45)), (420, dark), (385, light), (360, dark), (345, (250, 244, 225))):
        d.ellipse((c - r, c - r, c + r, c + r), fill=col)
    words = [w for w in re.split(r"[\s-]+", a['name']) if w[:1].isalnum()]
    small = {'a', 'an', 'the', 'of', 'on', 'to', 'in', 'and'}
    init = ''.join(w[0].upper() for w in words if w.lower() not in small)[:3] or a['name'][:2].upper()
    f = font(300 if len(init) <= 2 else 230)
    box = d.textbbox((0, 0), init, font=f)
    d.text((c - (box[0] + box[2]) / 2, c - (box[1] + box[3]) / 2 - 10), init, font=f, fill=(29, 88, 66))
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return buf.getvalue()


# ---------- App Store Connect API ----------
def clean_key(raw):
    """Rebuild the .p8 key as proper PEM, whatever pasting did to its line breaks."""
    import base64, re as _re
    s = raw.strip().strip('"').strip("'").replace('\\n', '\n').replace('\r', '')
    if '-----BEGIN' not in s:
        try:  # the whole file may have been base64-encoded
            d = base64.b64decode(s).decode()
            if '-----BEGIN' in d:
                s = d
        except Exception:
            pass
    body = _re.sub(r'-----(BEGIN|END)[A-Z ]*-----', '', s)
    body = _re.sub(r'[^A-Za-z0-9+/=]', '', body)
    if not body:
        sys.exit('APP_STORE_CONNECT_PRIVATE_KEY looks empty. Paste the whole text of the .p8 file.')
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return '-----BEGIN PRIVATE KEY-----\n' + '\n'.join(lines) + '\n-----END PRIVATE KEY-----\n'


def token():
    import jwt
    key = clean_key(os.environ['APP_STORE_CONNECT_PRIVATE_KEY'])
    now = int(time.time())
    return jwt.encode({'iss': os.environ['APP_STORE_CONNECT_ISSUER_ID'], 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'},
                      key, algorithm='ES256', headers={'kid': os.environ['APP_STORE_CONNECT_KEY_IDENTIFIER'], 'typ': 'JWT'})


_tok = [None, 0]


def call(method, path, body=None, ok404=False):
    if time.time() - _tok[1] > 900:
        _tok[0], _tok[1] = token(), time.time()
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + _tok[0], 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                txt = r.read().decode()
                return json.loads(txt) if txt else {}
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors='replace')
            if e.code == 404 and ok404:
                return None
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f'{method} {path} failed ({e.code}): {txt[:600]}')


def rel(kind, rid):
    return {'data': {'type': kind, 'id': rid}}


def main():
    for v in ('APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_KEY_IDENTIFIER', 'APP_STORE_CONNECT_PRIVATE_KEY'):
        if not os.environ.get(v):
            sys.exit(f'Missing {v}. Add it to the "app_store_credentials" environment group in Codemagic.')
    bundle = os.environ.get('BUNDLE_ID', 'com.spencerdeville.motorbaron')
    achs = read_achievements(find_game())
    print(f'{len(achs)} achievements, {sum(a["pts"] for a in achs)} points')

    apps = call('GET', f'/apps?filter[bundleId]={bundle}')['data']
    if not apps:
        sys.exit(f'No app with bundle ID {bundle} in App Store Connect.')
    app_id = apps[0]['id']
    gcd = call('GET', f'/apps/{app_id}/gameCenterDetail', ok404=True)
    if not gcd or not gcd.get('data'):
        print('Turning on Game Center for the app')
        gcd = call('POST', '/gameCenterDetails', {'data': {'type': 'gameCenterDetails', 'relationships': {'app': rel('apps', app_id)}}})
    gcd_id = gcd['data']['id']

    # If the app is in a Game Center group (shared with the free edition), everything lives in the group.
    grp = call('GET', f'/gameCenterDetails/{gcd_id}/gameCenterGroup', ok404=True)
    grp_id = grp['data']['id'] if grp and grp.get('data') else None
    owner = ('gameCenterGroups', grp_id, 'gameCenterGroup') if grp_id else ('gameCenterDetails', gcd_id, 'gameCenterDetail')
    print('Using the shared Game Center group' if grp_id else 'Using this app\'s own Game Center (no group)')

    def listall(url):
        out = {}
        while url:
            r = call('GET', url)
            for x in r['data']:
                vid = x['attributes']['vendorIdentifier']
                out[vid[4:] if vid.startswith('grp.') else vid] = x
            url = r.get('links', {}).get('next')
        return out

    existing = listall(f'/{owner[0]}/{owner[1]}/gameCenterAchievements?limit=200')

    failed = []
    for a in achs:
        vid = PREFIX + a['id']
        try:
            if vid in existing:
                x = existing[vid]
                attrs = x['attributes']
                if attrs.get('points') != a['pts'] or attrs.get('referenceName') != a['name']:
                    call('PATCH', f'/gameCenterAchievements/{x["id"]}', {'data': {'type': 'gameCenterAchievements', 'id': x['id'],
                         'attributes': {'points': a['pts'], 'referenceName': a['name']}}})
                ach_id = x['id']
                status = 'updated'
            else:
                x = call('POST', '/gameCenterAchievements', {'data': {'type': 'gameCenterAchievements',
                         'attributes': {'referenceName': a['name'], 'vendorIdentifier': ('grp.' if grp_id else '') + vid, 'points': a['pts'], 'showBeforeEarned': True, 'repeatable': False},
                         'relationships': {owner[2]: rel(owner[0], owner[1])}}})
                ach_id = x['data']['id']
                status = 'created'
            locs = call('GET', f'/gameCenterAchievements/{ach_id}/localizations')['data']
            loc = next((l for l in locs if l['attributes']['locale'] == 'en-US'), None)
            la = {'name': a['name'], 'beforeEarnedDescription': a['d'], 'afterEarnedDescription': a['d']}
            if loc:
                if any(loc['attributes'].get(k) != v for k, v in la.items()):
                    call('PATCH', f'/gameCenterAchievementLocalizations/{loc["id"]}', {'data': {'type': 'gameCenterAchievementLocalizations', 'id': loc['id'], 'attributes': la}})
            else:
                loc = call('POST', '/gameCenterAchievementLocalizations', {'data': {'type': 'gameCenterAchievementLocalizations',
                           'attributes': dict(la, locale='en-US'), 'relationships': {'gameCenterAchievement': rel('gameCenterAchievements', ach_id)}}})['data']
            img = call('GET', f'/gameCenterAchievementLocalizations/{loc["id"]}/gameCenterAchievementImage', ok404=True)
            art = art_png(a)
            fname = vid + ('-art2.png' if art else '.png')
            have = img and img.get('data')
            if have and art and (img['data'].get('attributes') or {}).get('fileName') != fname:
                # Replace the old lettered medal with the drawn one.
                call('DELETE', f'/gameCenterAchievementImages/{img["data"]["id"]}')
                have = None
                status += ', old image removed'
            if not have:
                png = art or medal_png(a)
                res = call('POST', '/gameCenterAchievementImages', {'data': {'type': 'gameCenterAchievementImages',
                           'attributes': {'fileName': fname, 'fileSize': len(png)},
                           'relationships': {'gameCenterAchievementLocalization': rel('gameCenterAchievementLocalizations', loc['id'])}}})['data']
                for op in res['attributes'].get('uploadOperations') or []:
                    chunk = png[op['offset']:op['offset'] + op['length']]
                    hdr = {h['name']: h['value'] for h in op.get('requestHeaders') or []}
                    urllib.request.urlopen(urllib.request.Request(op['url'], data=chunk, method=op['method'], headers=hdr), timeout=120).read()
                call('PATCH', f'/gameCenterAchievementImages/{res["id"]}', {'data': {'type': 'gameCenterAchievementImages', 'id': res['id'], 'attributes': {'uploaded': True}}})
                status += ', image uploaded'
            print(f'  {vid}: {status}')
        except Exception as e:
            print(f'  {vid}: FAILED - {e}')
            failed.append(vid)

    # ---------- leaderboards ----------
    boards = read_leaderboards(find_game())
    have = listall(f'/{owner[0]}/{owner[1]}/gameCenterLeaderboards?limit=200')
    print(f'{len(boards)} leaderboards')
    for b in boards:
        vid = 'motorbaron.lb.' + b['id']
        try:
            if vid in have:
                lb_id = have[vid]['id']
                status = 'already there'
            else:
                x = call('POST', '/gameCenterLeaderboards', {'data': {'type': 'gameCenterLeaderboards',
                         'attributes': {'referenceName': b['name'], 'vendorIdentifier': ('grp.' if grp_id else '') + vid,
                                        'defaultFormatter': b['fmt'], 'submissionType': 'BEST_SCORE', 'scoreSortType': 'DESC'},
                         'relationships': {owner[2]: rel(owner[0], owner[1])}}})
                lb_id = x['data']['id']
                status = 'created'
            locs = call('GET', f'/gameCenterLeaderboards/{lb_id}/localizations')['data']
            if not any(l['attributes']['locale'] == 'en-US' for l in locs):
                la = {'locale': 'en-US', 'name': b['name']}
                if b['fmt'] == 'INTEGER' and 'sold' in b['id'] or b['id'] == 'best_year':
                    la.update({'formatterSuffix': ' cars', 'formatterSuffixSingular': ' car'})
                try:
                    call('POST', '/gameCenterLeaderboardLocalizations', {'data': {'type': 'gameCenterLeaderboardLocalizations', 'attributes': la,
                         'relationships': {'gameCenterLeaderboard': rel('gameCenterLeaderboards', lb_id)}}})
                except RuntimeError:
                    la.pop('formatterSuffix', None); la.pop('formatterSuffixSingular', None)
                    call('POST', '/gameCenterLeaderboardLocalizations', {'data': {'type': 'gameCenterLeaderboardLocalizations', 'attributes': la,
                         'relationships': {'gameCenterLeaderboard': rel('gameCenterLeaderboards', lb_id)}}})
                status += ', name added'
            print(f'  {vid}: {status}')
        except Exception as e:
            print(f'  {vid}: FAILED - {e}')
            failed.append(vid)

    if failed:
        sys.exit(f'{len(failed)} items failed. Run the workflow again; finished ones are skipped.')
    print('All achievements and leaderboards are set up in App Store Connect.')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'images':
        out = sys.argv[2] if len(sys.argv) > 2 else 'medals'
        os.makedirs(out, exist_ok=True)
        for a in read_achievements(find_game()):
            open(os.path.join(out, PREFIX + a['id'] + '.png'), 'wb').write(medal_png(a))
        print('Wrote medal images to', out)
    else:
        main()
