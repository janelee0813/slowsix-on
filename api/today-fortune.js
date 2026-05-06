module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.', detail: 'ANTHROPIC_API_KEY missing' });
  }

  const now = new Date(new Date().toLocaleString('en', { timeZone: 'Asia/Seoul' }));
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const month = now.getMonth() + 1;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dayOfWeek = days[now.getDay()];

  const prompt = `오늘 날짜: ${dateStr} (${month}월 ${dayOfWeek}요일)

오늘의 운세를 감성적이고 따뜻하게 작성해줘. 긍정적이되 현실적으로, 20~40대 싱글들을 위한 운세로 부탁해.

반드시 아래 JSON만 응답해 (마크다운, 코드블록, 다른 텍스트 없이):
{
  "overall": "오늘의 운세 한마디 (20자 이내)",
  "overallDesc": "전체 운세 설명 (2~3문장, 오늘 날짜/요일 분위기 연결)",
  "love": "애정운 한마디 (10자 이내)",
  "loveDesc": "애정운 설명 (1~2문장)",
  "loveScore": 1에서 5 사이 정수,
  "work": "직업운 한마디 (10자 이내)",
  "workDesc": "직업운 설명 (1~2문장)",
  "workScore": 1에서 5 사이 정수,
  "money": "재물운 한마디 (10자 이내)",
  "moneyDesc": "재물운 설명 (1~2문장)",
  "moneyScore": 1에서 5 사이 정수,
  "health": "건강운 한마디 (10자 이내)",
  "healthDesc": "건강운 설명 (1~2문장)",
  "healthScore": 1에서 5 사이 정수,
  "luckyColor": "행운의 색 (색 이름만)",
  "luckyNumber": 1에서 99 사이 정수,
  "luckyKeyword": "오늘의 키워드 (5자 이내)",
  "advice": "오늘 하루를 위한 조언 (2문장)"
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
        max_tokens: 800,
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
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: '서버 오류', detail: e.message });
  }
};
