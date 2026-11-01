# Prints the round-2 result tables from results.json.
import json, sys
r = json.load(open(sys.argv[1]))
print('scored', r['scoredProfiles'])
print('eligible', r['eligible'], 'best', r['best'], 'chosen', r['chosen'])
print('\nprofile        teachRel testRel testAmb  scored')
for p, x in r['profiles'].items():
    c = x['counts']
    print(f"{p:14} {c['teachRelevant']:8} {c['testRelevant']:7} {c['testAmbiguous']:7}  {p in r['scoredProfiles']}")
names = sorted(r['macroF05'], key=lambda n: -r['macroF05'][n])
print('\nmacro over scored profiles: T11F, Brier skill, worst lower bound vs baselines')
for n in names:
    iv = r['intervalsVsBaselines'].get(n, {})
    low = min((v[0] for v in iv.values()), default=float('nan'))
    print(f"{n:22} {r['macroF05'][n]:.3f}  {r['macroBrierSkill'].get(n, float('nan')):+.3f}  {low:+.3f}")
