# -*- coding: utf-8 -*-
# Test de l'e-mail de confirmation (instance test uniquement). « pret » : verifie seulement que la nouvelle version repond.
import json, sys, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
B = 'https://lifeparty-benevoles.natquinson.workers.dev'
CODE = open('CODE_ORGANISATION.txt').read().strip()
H = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'X-Code-Organisation': CODE, 'Origin': 'https://choisislavie.org'}


def call(path, body=None, inst='test'):
    req = urllib.request.Request(f'{B}{path}?instance={inst}', data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET', headers=H)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())


base = {'parent': 'Test Courriel', 'email': 'test.lifeparty@example.com', 'telephone': '06 12 34 56 78', 'enfants': [{'prenom': 'Léa', 'age': 7}],
        'photo': 'oui', 'autorite': True, 'signature': 'Test Courriel', 'version': 'lets-play-2026-v1'}
if sys.argv[1:] == ['pret']:
    s, d = call('/api/familles/inscription', {**base, 'email': 'pas-un-email'})
    for f in call('/api/familles/liste')[1]['familles']: call('/api/familles/annulation', {'id': f['id']})
    sys.exit(0 if s == 400 else 1)
s, d = call('/api/familles/inscription', base)
print('inscription ->', s, '| email_envoye =', d.get('email_envoye'), '| billet', d.get('billet'))
s, d = call('/api/familles/liste')
print('journal :', [(j['action'], j['detail'][:120]) for j in d['journal'][:2]])
print('e-mail stocke :', [f.get('email') for f in d['familles']])
for f in d['familles']: call('/api/familles/annulation', {'id': f['id']})
print('test vide :', len(call('/api/familles/liste')[1]['familles']), '| live :', len(call('/api/familles/liste', inst='live')[1]['familles']))
