# -*- coding: utf-8 -*-
"""artifact.html 是版面的唯一來源；這支把它包成本機可雙擊用的 index.html。

Artifact 平台會自己補 <!doctype>/<head>/<body>，所以 artifact.html 裡不寫那些標籤。
本機版需要，就由這裡補上，避免兩份 HTML 各改各的而走鐘。
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'artifact.html')
OUT = os.path.join(HERE, 'index.html')

MARK = '<link rel="stylesheet" href="app.css">'

src = io.open(SRC, encoding='utf-8').read()
i = src.index(MARK) + len(MARK)
head, body = src[:i], src[i:]

doc = (
    '<!doctype html>\n'
    '<html lang="zh-Hant">\n'
    '<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + head + '\n'
    '</head>\n'
    '<body>\n'
    + body.lstrip('\n') +
    '</body>\n'
    '</html>\n'
)
io.open(OUT, 'w', encoding='utf-8', newline='\n').write(doc)
print('built', OUT, len(doc), 'chars')
