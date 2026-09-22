"""Build the OFL numeric subset for egui, which cannot select OpenType tnum.
Requires fonttools; only needed to regenerate this bundled asset.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset

root = Path(__file__).resolve().parent
font = TTFont(root / 'Pretendard-Bold.otf')
substitutions = {}
for feature in font['GSUB'].table.FeatureList.FeatureRecord:
    if feature.FeatureTag == 'tnum':
        for index in feature.Feature.LookupListIndex:
            for subtable in font['GSUB'].table.LookupList.Lookup[index].SubTable:
                substitutions.update(subtable.mapping)
for table in font['cmap'].tables:
    if table.isUnicode():
        table.cmap = {code: substitutions.get(glyph, glyph) for code, glyph in table.cmap.items()}
# Respect the upstream reserved font names for this modified subset.
for name in font['name'].names:
    if name.nameID in (1, 2, 3, 4, 6, 16, 17):
        values = {1:'Motomind Numbers', 2:'Bold', 3:'Motomind Numbers Bold 1.0',
                  4:'Motomind Numbers Bold', 6:'MotomindNumbers-Bold',
                  16:'Motomind Numbers', 17:'Bold'}
        name.string = values[name.nameID].encode(name.getEncoding())
cff = font['CFF '].cff
cff.fontNames = ['MotomindNumbers-Bold']
for top in cff.topDictIndex:
    top.FullName = 'Motomind Numbers Bold'
    top.FamilyName = 'Motomind Numbers'
options = subset.Options()
options.name_IDs = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=list(range(32, 127)) + [0xb0, 0xb1, 0xb2, 0xb7, 0xb5, 0x3bc, 0x3a9, 0x2013, 0x2212])
subsetter.subset(font)
font.save(root / 'MotomindNumbers-Bold.otf')
widths = [font['hmtx'][font.getBestCmap()[ord(c)]][0] for c in '0123456789']
assert len(set(widths)) == 1, widths
print('Tabular digit advances:', widths)
