export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const now = new Date(new Date().toLocaleString('en', { timeZone: 'Asia/Seoul' }));
  const dateStr = now.toISOString().slice(0, 10);
  const month = now.getMonth() + 1;
  const hour = now.getHours();

  // 날씨 조회 (wttr.in, 서울 기준)
  let weatherDesc = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const w = await fetch('https://wttr.in/Seoul?format=j1', { signal: controller.signal });
    clearTimeout(timeout);
    const wJson = await w.json();
    const c = wJson.current_condition[0];
    weatherDesc = `${c.weatherDesc[0].value}, 기온 ${c.temp_C}°C, 습도 ${c.humidity}%`;
  } catch {
    const seasons = ['겨울', '겨울', '봄', '봄', '봄', '여름', '여름', '여름', '가을', '가을', '가을', '겨울'];
    weatherDesc = `${seasons[month - 1]} 날씨`;
  }

  const timeOfDay = hour < 12 ? '오전' : hour < 18 ? '오후' : '저녁';

  const prompt = `오늘 날짜: ${dateStr} (${month}월 ${timeOfDay}), 서울 날씨: ${weatherDesc}

오늘의 날씨와 계절, 시간대에 딱 어울리는 술과 안주를 추천해줘.
한국의 술 문화를 반영하고, 감성적이고 공감되는 추천이면 좋겠어.

아래 JSON 형식으로만 응답해줘 (마크다운, 코드블록 없이 JSON만):
{
  "drink": "술 이름",
  "drinkEmoji": "어울리는 이모지 1개",
  "drinkDesc": "오늘 이 술을 추천하는 이유 (날씨/분위기 연결, 1~2문장)",
  "snack": "안주 이름",
  "snackEmoji": "어울리는 이모지 1개",
  "snackDesc": "이 안주를 추천하는 이유 (1~2문장)",
  "mood": "오늘 이 술자리의 무드 (10자 이내, 감성적으로)",
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
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    const text = data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch[0]);
    result.date = dateStr;
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: '잠시 후 다시 시도해주세요.' });
  }
}
