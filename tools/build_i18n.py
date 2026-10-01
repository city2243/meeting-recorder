# -*- coding: utf-8 -*-
"""
把 i18n/units.json（抽出的中文）＋ i18n/en.json（譯文）＋ 手動補充，合成 js/i18n-en.js。

檢查（任何一項失敗就 exit 1，不產出檔案）：
  - 每一段中文都有譯文
  - 譯文裡不能殘留中文
  - 樣板的 {1} {2} 佔位，中英數量要一致
  - 譯文不能是空的

之後新增了中文介面字串，流程是：
  1. node tools/extract_i18n.mjs i18n/units.json    重新抽
  2. 只翻新增的那些，補進 i18n/en.json
  3. python tools/build_i18n.py
"""
import io, json, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
CJK = re.compile(r'[㐀-鿿　-〿＀-￯]')

# 程式裡刻意拆開呼叫 t() 的字串、以及後來補的，抽取時抓不到，在這裡人工補
MANUAL = {
    '確定要取消訂閱？': 'Cancel your subscription?',
    '系統會通知綠界停止之後的扣款。已經付款的這一期可以繼續用到期滿，不會按比例退款。':
        "We'll tell ECPay to stop future charges. The period you've already paid for stays active until it ends and isn't refunded pro rata.",
    '英文版僅為方便閱讀的翻譯，內容如有歧義，以中文版為準。':
        'This English version is a translation for convenience only. If anything is unclear or inconsistent, the Chinese version prevails.',
    # pricing.html 用字串拼 HTML，抽取時連標籤一起切歪了；這裡補執行時真正出現的片段
    '這個網址是自用版，沒有接金流。要訂閱請到': 'This is the personal copy and has no payment set up. To subscribe, go to the',
    '正式站': 'official site',
    # multi.js 用 innerHTML 產生的輸入框提示，原本抽取時整個標籤被略過
    '這場叫什麼？例如「台積電法說」': 'Name this meeting, e.g. "TSMC earnings call"',
    # 2026-10-01：沒通過檢查時，開始鈕改成變灰＋寫原因
    '未通過檢查': 'Check failed',
    '還不能開始：先修好下面打 ✕ 的項目': "Can't start yet: fix the items marked ✕ below",
    '先解決上面「這一場的聲音」：重新選擇時把「分享分頁音訊」勾起來，會自動再試錄一次。':
        'Fix "Audio for this meeting" above first: choose again and select "Also share tab audio". The test recording will run again automatically.',
}


def main():
    units = json.load(io.open(os.path.join(ROOT, 'i18n', 'units.json'), encoding='utf-8'))
    en = json.load(io.open(os.path.join(ROOT, 'i18n', 'en.json'), encoding='utf-8'))
    errs = []

    ids = {u['id'] for u in units}
    missing = ids - set(en)
    extra = set(en) - ids
    if missing: errs.append(f'缺譯文 {len(missing)} 段：{sorted(missing)[:10]}')
    if extra: errs.append(f'多出不存在的 id {len(extra)} 個：{sorted(extra)[:10]}')

    exact, patterns = {}, []
    for u in units:
        e = en.get(u['id'])
        if e is None: continue
        if not str(e).strip(): errs.append(f"{u['id']} 譯文是空的"); continue
        if CJK.search(e): errs.append(f"{u['id']} 譯文殘留中文：{e[:60]}")
        zp = Counter(re.findall(r'\{\d+\}', u['zh']))
        ep = Counter(re.findall(r'\{\d+\}', e))
        if zp != ep: errs.append(f"{u['id']} 佔位不一致 zh={dict(zp)} en={dict(ep)}")
        if u['kind'] == 'pattern' and zp:
            patterns.append([u['zh'], e])
        else:
            exact[u['zh']] = e

    for zh, e in MANUAL.items():
        if CJK.search(e): errs.append(f'MANUAL 殘留中文：{zh}')
        exact[zh] = e

    if errs:
        print('\n'.join('✕ ' + x for x in errs[:40]))
        print(f'共 {len(errs)} 個問題，未產出檔案。')
        sys.exit(1)

    out = ('// 由 tools/build_i18n.py 產生，不要手改。來源：i18n/units.json + i18n/en.json\n'
           'export const EXACT = ' + json.dumps(exact, ensure_ascii=False, indent=0) + ';\n'
           'export const PATTERNS = ' + json.dumps(patterns, ensure_ascii=False, indent=0) + ';\n')
    io.open(os.path.join(ROOT, 'js', 'i18n-en.js'), 'w', encoding='utf-8', newline='\n').write(out)
    print(f'✓ js/i18n-en.js：固定文字 {len(exact)} 段、樣板 {len(patterns)} 段，{len(out.encode("utf-8"))//1024} KB')


if __name__ == '__main__':
    main()
