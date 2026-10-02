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
    # 2026-10-02：會議結束自動停止並存檔
    '會議結束時自動停止並存檔': 'Stop and save automatically when the meeting ends',
    '會議分頁被關掉、或按了「停止共用」：10 秒後自動停止並存檔（一律開啟；10 秒內按「重新接上畫面」可以接著錄）。': 'If the meeting tab closes or someone selects "Stop sharing", recording stops and saves after 10 seconds (always on; select "Reconnect screen" within 10 seconds to keep recording).',
    '會議結束了但畫面還開著：連續': 'If the meeting has ended but the screen is still open: after',
    '分鐘完全沒有會議聲音，就判定會議結束，自動停止並存檔': 'minutes with no meeting sound at all, treat the meeting as ended and stop and save automatically',
    '某一場的會議分頁被關掉、或按了「停止共用」：那一場 3 秒後自動停止並存檔，其他場照常錄（一律開啟）。': 'If a meeting\'s tab closes or someone selects "Stop sharing", that meeting stops and saves after 3 seconds while the others keep recording (always on).',
    '會議結束了但分頁還開著：某一場連續': 'If a meeting has ended but its tab is still open: after',
    '分鐘完全沒有聲音，就判定那場結束，自動停止並存檔': 'minutes with no sound at all, treat that meeting as ended and stop and save it automatically',
    '影像沒問題，這個分頁這 4 秒剛好沒出聲。如果會議還沒開始或沒人講話，可以照樣開始，錄製中會繼續盯著；如果它正在講話，代表音訊沒抓到。': "Video is fine; the tab just made no sound in these 4 seconds. If the meeting hasn't started or nobody is talking, you can still start and recording keeps monitoring. If someone is speaking, the audio isn't being captured.",
    '會議分頁被關掉，或按了「停止共用」。10 秒後自動停止並存檔；要接著錄，請在那之前按「重新接上畫面」。': 'The meeting tab closed or someone selected "Stop sharing". Recording stops and saves in 10 seconds. To keep recording, select "Reconnect screen" before then.',
    '會議分享已結束（分頁被關掉或按了停止共用），自動停止並存檔': 'Meeting sharing ended (tab closed or Stop sharing selected). Stopping and saving automatically',
    '沒有重新接上畫面，10 秒後自動停止並存檔': 'Screen was not reconnected. Stopping and saving in 10 seconds',
    # 2026-10-02：分享視窗示意圖依真的 Chrome／Edge 截圖重畫（上方分頁籤、底部音訊開關）
    '分享視窗示意圖：選上方的整個螢幕畫面，並把底部的分享系統音訊開關打開': 'Share window illustration: choose Entire Screen at the top and turn on the "Also share system audio" switch at the bottom',
    '分享視窗示意圖：選上方的 Chrome 分頁，確認底部的分享分頁音訊開關是開的': 'Share window illustration: choose Chrome Tab at the top and make sure the "Also share tab audio" switch at the bottom is on',
    'Zoom、Webex、Teams 是獨立的桌面程式，不是網頁分頁。要錄到它們的聲音， 在分享視窗上方必須選「': 'Zoom, Webex and Teams are desktop programs, not browser tabs. To record their sound, at the top of the share window choose "',
    '整個螢幕畫面': 'Entire Screen',
    '」（Edge 叫「整個螢幕」）， 並把底部「': '" (Edge: "Entire screen"), and at the bottom turn on the "',
    '分享系統音訊': 'Also share system audio',
    '」（Edge 叫「共用系統音訊」）的開關': '" switch (Edge: "Share system audio")',
    '打開——它預設是關的': '. It is off by default',
    '選擇要與這個網站分享的內容': 'Choose what to share with this site',
    '網站將能查看你的畫面內容': 'The site will be able to see the contents of your screen',
    '（預設是關的，要打開）': '(off by default, turn it on)',
    '上方點「整個螢幕畫面」（Edge 叫「整個螢幕」）——選「視窗」抓不到任何聲音': 'At the top, choose "Entire Screen" (Edge: "Entire screen"). Choosing "Window" captures no sound at all',
    '底部「分享系統音訊」的開關': 'The "Also share system audio" switch at the bottom ',
    '預設是關的，一定要打開': 'is off by default. You must turn it on',
    '——沒開就只有畫面沒聲音': '. Without it you get video but no sound',
    '在分享視窗上方點「': 'At the top of the share window, choose "',
    '」（Edge 叫「Microsoft Edge 索引標籤」），挑會議那個分頁； 底部「': '" (Edge: "Microsoft Edge tab") and pick the meeting\'s tab. The "',
    '分享分頁音訊': 'Also share tab audio',
    '」的開關預設就是開的，確認沒被關掉。': '" switch at the bottom is on by default. Make sure it has not been turned off.',
    '，不會混到電腦上其他聲音， 逐字稿品質最好。下一步會實際驗證，音訊沒開不讓你開始錄。': ', without other sounds from your computer, which gives the best transcripts. The next step verifies it, and you cannot start if audio is off.',
    '預覽': 'Preview',
    '（預設就是開的）': '(on by default)',
    '上方點「Chrome 分頁」（Edge 叫「Microsoft Edge 索引標籤」），挑會議那一個': 'At the top, choose "Chrome Tab" (Edge: "Microsoft Edge tab") and pick the meeting',
    '底部「分享分頁音訊」的開關': 'The "Also share tab audio" switch at the bottom ',
    '預設就是開的': 'is on by default',
    '，確認它是亮的、不要關掉': '. Make sure it is lit and leave it on',
    '選分頁時，底部的「分享分頁音訊」開關要是開的（預設就是開的，不要關掉）。': 'When choosing a tab, the "Also share tab audio" switch at the bottom must be on (it is on by default, so leave it on).',
    '關掉就只有畫面沒聲音， 下一步會擋住不讓你開始。': 'If it is off you get video but no sound, and the next step will not let you start.',
    '瀏覽器會跳出分享視窗，照下圖的兩個位置確認（圖是 Chrome；Edge 長得一樣，只是名稱不同）：': 'Your browser opens a share window. Check the two spots shown below (the picture shows Chrome; Edge looks the same with different names):',
    '上方點「Chrome 分頁」（Edge 叫「Microsoft Edge 索引標籤」），再點會議那一個。': 'At the top, choose "Chrome Tab" (Edge: "Microsoft Edge tab"), then click the meeting.',
    '不要選「整個螢幕畫面」或「視窗」——那是整台電腦的聲音，所有會議會混在一起': 'Do not choose "Entire Screen" or "Window". Those capture all of the computer\'s sound, so every meeting gets mixed together',
    '底部「分享分頁音訊」（Edge 叫「共用索引標籤音訊」）的開關': 'The "Also share tab audio" switch at the bottom (Edge: "Share tab audio") ',
    '，確認它是亮的、不要關掉，再按「分享」': '. Make sure it is lit and leave it on, then select "Share"',
    '你選成「整個螢幕畫面」或「視窗」了。那抓的是整台電腦的混音，四場會混在一起。 現在檢查會直接擋下來；按「重新選擇」改成「Chrome 分頁」（Edge 是「Microsoft Edge 索引標籤」）。': 'You chose "Entire Screen" or "Window". That captures all of the computer\'s sound, so the four meetings get mixed. The check now blocks this. Select "Choose again" and pick "Chrome Tab" (Edge: "Microsoft Edge tab").',
    '分享時把底部「分享分頁音訊」的開關關掉了。檢查會擋下來，按「重新選擇」再選一次就好。': 'The "Also share tab audio" switch was turned off when sharing. The check blocks this. Select "Choose again" and share again.',
    '按「重新檢查」重選：分享視窗上方點「Chrome 分頁」（Edge 叫「Microsoft Edge 索引標籤」），確認底部「分享分頁音訊」的開關是開的。': 'Select "Check again" and choose again: at the top of the share window choose "Chrome Tab" (Edge: "Microsoft Edge tab"), and make sure the "Also share tab audio" switch at the bottom is on.',
    '按「重新檢查」重選：分享視窗上方點「整個螢幕畫面」，並把底部「分享系統音訊」的開關打開（它預設是關的）。': 'Select "Check again" and choose again: at the top of the share window choose "Entire Screen", and turn on the "Also share system audio" switch at the bottom (it is off by default).',
    '如果會議現在本來就安靜，可以照樣開始；如果它正在講話，代表分享時把底部「分享分頁音訊」的開關關掉了。讓那個分頁發出聲音再按下面重測。': 'If the meeting is quiet right now, you can still start. If someone is speaking, the "Also share tab audio" switch was turned off when sharing. Make the tab play sound, then test again below.',
    '多場模式就緒。每一場請選一個瀏覽器分頁，並確認分享視窗底部「分享分頁音訊」的開關是開的。': 'Multi-meeting mode is ready. Choose one browser tab per meeting, and make sure the "Also share tab audio" switch at the bottom of the share window is on.',
    '按「重新選擇」，在分享視窗底部確認「分享分頁音訊」（Edge 叫「共用索引標籤音訊」）的開關是開的。關掉就只有畫面沒聲音。': 'Select "Choose again" and make sure the "Also share tab audio" switch (Edge: "Share tab audio") at the bottom of the share window is on. If it is off you get video but no sound.',
    '先解決上面「這一場的聲音」：按「重新選擇」，確認底部「分享分頁音訊」的開關是開的，會自動再試錄一次。': 'Fix "Audio for this meeting" above first: select "Choose again" and make sure the "Also share tab audio" switch at the bottom is on. The test recording will run again automatically.',
    '檢查分享視窗底部「分享分頁音訊」的開關是不是開的。': 'Check whether the "Also share tab audio" switch at the bottom of the share window is on.',
    # 2026-10-01：Edge 名稱、非分頁來源改成擋下、靜止畫面
    '有聲音，但這是整台電腦的混音（不是這個分頁專屬的），其他會議也會被錄進來': "There is audio, but it is the whole computer's mix (not this tab's own), so other meetings will be recorded too",
    '瀏覽器會跳出分享視窗，照下圖的兩個位置操作（圖是 Chrome；Edge 的位置一樣，只是名稱不同）：': 'Your browser opens a share window. Use the two spots shown below (the picture shows Chrome; Edge has them in the same places with different names):',
    '切到「Chrome 分頁」（Edge 叫「Microsoft Edge 索引標籤」），挑會議那一個。': 'Switch to "Chrome Tab" (in Edge: "Microsoft Edge tab") and pick the meeting.',
    '不要選「整個畫面」或「視窗」——那是整台電腦的聲音，所有會議會混在一起': 'Do not pick "Entire Screen" or "Window". Those capture all of the computer\'s sound, so every meeting gets mixed together',
    '左下角勾「同時分享分頁音訊」（Edge 寫「索引標籤音訊」）——': 'At the bottom left, select "Also share tab audio" (in Edge it mentions "tab audio"). ',
    '你選成「整個畫面」或「視窗」了。那抓的是整台電腦的混音，四場會混在一起。 現在檢查會直接擋下來；按「重新選擇」改成「Chrome 分頁」（Edge 是「Microsoft Edge 索引標籤」）。': 'You picked "Entire Screen" or "Window". That captures all of the computer\'s sound, so the four meetings get mixed. The check now blocks this. Select "Choose again" and pick "Chrome Tab" (in Edge: "Microsoft Edge tab").',
    '四場一起選很容易挑錯。開錄後看每一格的「這場的聲音」音量條：跟你聽到的那場會議同時跳動就對了；對不上就停止那一格、按「清除這一格」，再「＋ 加一場」重選。': 'It is easy to pick the wrong tab when setting up four. After recording starts, watch each slot\'s "Audio for this meeting" meter: it should move together with the meeting you hear. If it doesn\'t, stop that slot, select "Clear this slot", then "+ Add a meeting" and choose again.',
    '分享的視窗可能被最小化了。把它還原後按「重新檢查」。': 'The shared window may be minimized. Restore it, then select "Check again".',
    '分頁或畫面內容沒在動的時候，Chrome 不會送新畫格（例如會議還沒開始、停在一張投影片），這是正常的。下面的試錄會確認影像真的錄得到。': "When nothing on the tab or screen is moving (for example, the meeting hasn't started or is paused on a slide), Chrome sends no new frames. This is normal. The test recording below confirms that video really records.",
    '畫面 5 分鐘沒有變化': 'Video unchanged for 5 minutes',
    '如果會議一直停在同一張投影片，可以忽略；聲音照常在錄。': 'If the meeting has stayed on the same slide, you can ignore this. Audio is still recording.',
    '按「重新選擇」，在分享視窗上方切到分頁那一欄（Chrome 叫「Chrome 分頁」，Edge 叫「Microsoft Edge 索引標籤」），點這場會議的分頁。桌面版會議軟體請改用「錄一場」。': 'Select "Choose again", switch to the tabs section at the top of the share window ("Chrome Tab" in Chrome, "Microsoft Edge tab" in Edge), and click this meeting\'s tab. For desktop meeting apps, use "Single meeting" instead.',
    '重新選擇時，在分享視窗左下角把分享音訊的選項勾起來（Chrome 寫「分享分頁音訊」，Edge 寫「分享索引標籤音訊」）。沒勾就只有畫面沒聲音。': 'When choosing again, select the audio option at the bottom left of the share window ("Also share tab audio"). Without it you get video but no audio.',
    '分享的視窗可能被最小化了，把它還原後按「重新選擇」。': 'The shared window may be minimized. Restore it, then select "Choose again".',
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
    ['連續 {1} 分鐘沒有會議聲音，判定會議已結束，自動停止並存檔', 'No meeting sound for {1} minutes. Treating the meeting as ended and stopping and saving automatically'],
    ['「{1}」連續 {2} 分鐘沒有聲音，判定會議已結束，自動停止並存檔', 'No sound from "{1}" for {2} minutes. Treating it as ended and stopping and saving automatically'],
    ['目前畫面沒有變化（2.5 秒收到 {1} 張）', 'Video is not changing right now ({1} frames in 2.5 seconds)'],
    ['目前畫面沒有變化（2.2 秒收到 {1} 張）', 'Video is not changing right now ({1} frames in 2.2 seconds)'],
    ['{1}（不是分頁）—— 錄到的會是整台電腦的聲音，所有會議會混在一起', "{1} (not a tab). This records all of the computer's sound, so every meeting gets mixed together"],
    ['已經 {1} 秒沒有新畫格，分享的視窗可能被最小化了。', 'No new frames for {1} seconds. The shared window may be minimized.'],
    ['「{1}」畫面 5 分鐘沒有變化', 'Video for "{1}" unchanged for 5 minutes'],
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
