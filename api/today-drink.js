const SUPABASE_URL = 'https://teugnaahpcpzejbdayyy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRldWduYWFocGNwemVqYmRheXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3NzkwMzIsImV4cCI6MjA5MzM1NTAzMn0.cbIoK_4DpEacggY5kDVRO799h_z-VtMjADyya2EF1SA';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.', detail: 'ANTHROPIC_API_KEY missing' });
  }

  const now = new Date(new Date().toLocaleString('en', { timeZone: 'Asia/Seoul' }));
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const month = now.getMonth() + 1;
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? '오전' : hour < 18 ? '오후' : '저녁';

  // Supabase 캐시 확인
  try {
    const cacheRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_drinks?date=eq.${dateStr}&select=data`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (cacheRes.ok) {
      const cached = await cacheRes.json();
      if (cached.length > 0) return res.status(200).json(cached[0].data);
    }
  } catch (_) {}

  let weatherDesc = '';
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    const w = await fetch('https://wttr.in/Seoul?format=j1', { signal: controller.signal });
    clearTimeout(tid);
    const wJson = await w.json();
    const c = wJson.current_condition[0];
    weatherDesc = `${c.weatherDesc[0].value}, 기온 ${c.temp_C}°C, 습도 ${c.humidity}%`;
  } catch {
    const seasons = ['겨울','겨울','봄','봄','봄','여름','여름','여름','가을','가을','가을','겨울'];
    weatherDesc = `${seasons[month - 1]} 날씨`;
  }

  const prompt = `오늘 날짜: ${dateStr} (${month}월 ${timeOfDay}), 서울 날씨: ${weatherDesc}

오늘의 날씨와 계절에 딱 어울리는 술자리 추천을 해줘. 한국 술 문화를 반영하고 감성적으로 부탁해.

반드시 아래 JSON만 응답해 (마크다운, 코드블록, 다른 텍스트 없이):
{
  "drink": "술 이름",
  "drinkEmoji": "이모지 1개",
  "drinkDesc": "오늘 이 술을 추천하는 이유 (1~2문장, 날씨/분위기 연결)",
  "snack": "안주 이름",
  "snackEmoji": "이모지 1개",
  "snackDesc": "이 안주 추천 이유 (1~2문장)",
  "place": "오늘 분위기에 어울리는 장소/술집 스타일 (예: 아늑한 이자카야, 야외 포차 등)",
  "placeEmoji": "이모지 1개",
  "placeDesc": "이 장소를 추천하는 이유 (1~2문장, 날씨 연결)",
  "topic": "오늘 술자리에서 나누기 좋은 대화 주제 한 가지",
  "topicEmoji": "이모지 1개",
  "topicDesc": "이 주제가 오늘 술자리에 어울리는 이유 (1~2문장)",
  "tip": "이 술+안주 조합을 더 맛있게 즐기는 팁 (1~2문장)",
  "tipEmoji": "이모지 1개",
  "mood": "오늘 술자리 무드 한마디 (10자 이내)",
  "weather": "${weatherDesc}"
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(500).json({ error: 'Claude API 오류', detail: errText });
    }

    const data = await r.json();
    const text = data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'JSON 파싱 실패', detail: text });
    }
    const result = JSON.parse(jsonMatch[0]);
    result.date = dateStr;

    // Supabase에 오늘 결과 저장
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/daily_drinks`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ date: dateStr, data: result })
      });
    } catch (_) {}

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: '서버 오류', detail: e.message });
  }
};
