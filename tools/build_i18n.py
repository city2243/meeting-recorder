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
    # 2026-10-01：多場版全面檢查後新增（救援清單、分享中斷自動收檔、存檔失敗改下載）
    '還存在瀏覽器本機儲存區裡。可能是上次當掉或關掉頁面，也可能是匯出後沒清掉。標「尚未匯出」的請先另存。':
        'These are still in browser storage, from a crash, a closed page, or an export that was not cleared. Save anything marked "Not exported" first.',
    '有檔案沒存進資料夾，請按下面的「下載」另存：': 'Some files did not save to the folder. Use "Download" below to save them:',
    '分享已經結束（分頁被關掉，或按了「停止共用」）': 'Sharing has ended (the tab closed, or someone selected "Stop sharing")',
    '按「重新選擇」再挑一次這場的分頁。': 'Select "Choose again" and pick this meeting\'s tab again.',
    '開始錄之前分享就結束了，需要重新選擇分頁': 'Sharing ended before recording started. Choose the tab again.',
    '分頁被關掉、或有人按了「停止共用」。已經錄到的內容會自動收檔保存。':
        'The tab closed or someone selected "Stop sharing". What was already recorded will be saved automatically.',
    '只刪掉「已匯出過」的暫存副本，尚未匯出的會留著。請先確認資料夾裡的檔案可以正常播放。':
        'Only temporary copies marked "Exported" will be deleted. Anything not exported is kept. First check that the files in your folder play correctly.',
    '先解決上面「這一場的聲音」：重新選擇時把「分享分頁音訊」勾起來，會自動再試錄一次。':
        'Fix "Audio for this meeting" above first: choose again and select "Also share tab audio". The test recording will run again automatically.',
}

# 執行時才組出來、帶變數的句子（抽取後還沒進 en.json 的）
MANUAL_PATTERNS = [
    ['「{1}」的分享已中斷，自動停止並保存已錄到的內容', 'Sharing for "{1}" was interrupted. Stopping automatically and saving what was recorded'],
    ['清除已匯出過的 {1} 個暫存檔', 'Clear {1} exported temporary files'],
    # 警示寫進事件紀錄的格式（slot.js raise）：整句先比對，標題與說明再各自翻，不要被片段替換切碎
    ['【嚴重】{1} — {2}', '[Critical] {1} — {2}'],
    ['【注意】{1} — {2}', '[Attention] {1} — {2}'],
]


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
    for zh, e in MANUAL_PATTERNS:
        if CJK.search(e): errs.append(f'MANUAL_PATTERNS 殘留中文：{zh}')
        if Counter(re.findall(r'\{\d+\}', zh)) != Counter(re.findall(r'\{\d+\}', e)): errs.append(f'MANUAL_PATTERNS 佔位不一致：{zh}')
        if not any(x[0] == zh for x in patterns): patterns.append([zh, e])

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
