#!/usr/bin/env python3
"""Lists what the last `npm run test:unit` left uncovered, with the source line for each entry.

    python3 scripts/uncovered.py                 # every file
    python3 scripts/uncovered.py server/app.ts   # one file, every statement/branch/function

Run from web/. Reads coverage/unit/coverage-final.json, which the unit run writes.
"""
import json, os, sys

REPORT = os.path.join(os.path.dirname(__file__), '..', 'coverage', 'unit', 'coverage-final.json')


def entries(data):
    out = []
    for sid, count in data['s'].items():
        if count == 0:
            loc = data['statementMap'][sid]
            out.append((loc['start']['line'], 'statement', loc['start']['column']))
    for bid, counts in data['b'].items():
        branch = data['branchMap'][bid]
        for index, count in enumerate(counts):
            if count == 0:
                loc = branch['locations'][index] if index < len(branch['locations']) else branch['loc']
                if not loc.get('start', {}).get('line'):
                    loc = branch['loc']
                out.append((loc['start']['line'], f"branch:{branch['type']}#{index}", loc['start']['column']))
    for fid, count in data['f'].items():
        if count == 0:
            loc = data['fnMap'][fid]['loc']
            out.append((loc['start']['line'], 'function:' + data['fnMap'][fid]['name'], loc['start']['column']))
    return sorted(out)


def main():
    if not os.path.exists(REPORT):
        sys.exit('no coverage/unit/coverage-final.json: run `npm run test:unit` first')
    wanted = sys.argv[1] if len(sys.argv) > 1 else None
    coverage = json.load(open(REPORT))
    total = 0
    for path, data in sorted(coverage.items()):
        if wanted and not path.endswith(wanted):
            continue
        found = entries(data)
        if not found:
            continue
        source = open(path, encoding='utf8').read().split('\n')
        print(f"== {os.path.relpath(path)}")
        for line, kind, column in found:
            total += 1
            print(f"{line:5} {kind:24} col {column:3} | {source[line - 1].strip()[:140]}")
    print('nothing uncovered' if total == 0 else f'{total} uncovered entries')


if __name__ == '__main__':
    main()
