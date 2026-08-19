const nodemailer = require('nodemailer');

const NAVER_PRESS_CODE_MAP = {
  '087': '강원일보', '654': '강원도민일보', '658': 'G1방송',
  '023': '조선일보', '025': '중앙일보', '020': '동아일보', '047': '한국일보', 
  '081': '서울신문', '021': '문화일보', '022': '세계일보', '005': '국민일보', 
  '028': '한겨레', '032': '경향신문', '056': 'KBS', '214': 'MBC', 
  '055': 'SBS', '396': 'EBS', '437': 'JTBC', '448': 'TV조선', 
  '449': '채널A', '057': 'MBN', '052': 'YTN', '422': '연합뉴스TV', 
  '001': '연합뉴스', '421': '뉴스1', '003': '뉴시스', '009': '매일경제', 
  '015': '한국경제', '011': '서울경제', '018': '이데일리', '088': '머니투데이', 
  '014': '파이낸셜뉴스', '277': '아시아경제', '016': '헤럴드경제', '366': '조선비즈', 
  '029': '디지털타임스', '030': '전자신문', '079': '노컷뉴스', '002': '프레시안', 
  '119': '데일리안', '031': '아이뉴스24', '629': '더팩트', '143': '쿠키뉴스'
};

function cleanHtmlTags(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDate(date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(/\. /g, '.').replace(':', ':');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectNaverNews() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('❌ NAVER API Key가 설정되지 않았습니다.');
  }

  const queries = ['강원특별자치도', '강원도', '강원'];
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  
  let rawArticles = [];
  let seenUrls = new Set();

  for (const query of queries) {
    let items = [];
    const encodedQuery = encodeURIComponent(query);
    const apiHubUrl = 'https://naverapihub.apigw.ntruss.com/search/v1/news?query=' + encodedQuery + '&display=100&sort=date';
    
    try {
      let response = await fetch(apiHubUrl, {
        headers: {
          'X-NCP-APIGW-API-KEY-ID': clientId,
          'X-NCP-APIGW-API-KEY': clientSecret
        }
      });

      if (!response.ok) {
        const devUrl = 'https://openapi.naver.com/v1/search/news.json?query=' + encodedQuery + '&display=100&sort=date';
        response = await fetch(devUrl, {
          headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret
          }
        });
      }

      if (response.ok) {
        const json = await response.json();
        items = json.items || [];
      }
    } catch (e) {
      console.log('⚠️ 네이버 API 처리 중 오류 (' + query + '): ' + e.message);
    }

    items.forEach(item => {
      const pubDate = new Date(item.pubDate);
      const isValidDate = !isNaN(pubDate.getTime());
      
      if (!isValidDate || pubDate >= twentyFourHoursAgo) {
        const originLink = item.originallink || '';
        const itemLink = item.link || '';
        const naverLink = itemLink.includes('news.naver.com') ? itemLink : (originLink.includes('news.naver.com') ? originLink : '');

        if (naverLink && !seenUrls.has(naverLink)) {
          const pressCodeMatch = naverLink.match(/article\/(\d{3})\//) || 
                                 naverLink.match(/oid=(\d{3})/) || 
                                 naverLink.match(/article\/(\d{3})/);

          if (pressCodeMatch && pressCodeMatch[1]) {
            const pressCode = pressCodeMatch[1];
            
            if (NAVER_PRESS_CODE_MAP[pressCode]) {
              seenUrls.add(naverLink);
              rawArticles.push({
                pressCode: pressCode,
                pressName: NAVER_PRESS_CODE_MAP[pressCode],
                title: cleanHtmlTags(item.title),
                description: cleanHtmlTags(item.description),
                link: naverLink,
                pubDate: isValidDate ? formatDate(pubDate) : formatDate(now)
              });
            }
          }
        }
      }
    });
  }

  const final45Articles = rawArticles.slice(0, 45);
  console.log('✅ 1차 네이버 뉴스 및 사설 수집 완료: 총 ' + final45Articles.length + '건');
  return final45Articles;
}

async function fetchArticleFullText(articles) {
  console.log('🔄 네이버 뉴스 본문 크롤링 시작 (병렬 비동기 처리)...');
  
  const excludeKeywords = [
    '날씨', '기온', '무더위', '열대야', '비소식', '낮에는',
    '음주운전', '마약', '절도', '경찰', '입건', '체포', '고발', 
    '주가', '증권', '유상증자', '포토뉴스', '특산품', '시식', '맛집', '소방','시상식','을지연습'
  ];

  const filteredArticles = articles.filter(article => {
    const combinedText = (article.title + ' ' + article.description).toLowerCase();
    return !excludeKeywords.some(kw => combinedText.includes(kw));
  });

  const promises = filteredArticles.map(async (article, idx) => {
    let fullText = article.description;
    try {
      const res = await fetch(article.link, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (res.ok) {
        const html = await res.text();
        let bodyMatch = html.match(/<article[^>]*id=["']dic_area["'][^>]*>([\s\S]*?)<\/article>/i) ||
                        html.match(/<div[^>]*id=["']newsct_article["'][^>]*>([\s\S]*?)<\/div>/i) ||
                        html.match(/<div[^>]*id=["']articeBody["'][^>]*>([\s\S]*?)<\/div>/i);

        if (bodyMatch && bodyMatch[1]) {
          fullText = cleanHtmlTags(bodyMatch[1]);
        }
      }
    } catch (e) {}

    const truncatedContent = fullText.length > 400 ? fullText.substring(0, 400) + '...' : fullText;

    return {
      id: idx + 1,
      pressCode: article.pressCode,
      pressName: article.pressName,
      title: article.title,
      link: article.link,
      pubDate: article.pubDate,
      content: truncatedContent
    };
  });

  return Promise.all(promises);
}

async function processNewsWithGeminiAI(articlesWithContent) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('❌ GEMINI_API_KEY가 설정되지 않았습니다.');
  }

  const modelsToTry = [
    'gemini-3.6-flash'
  ];

  const systemPrompt = `
당신은 강원특별자치도 정책 및 도정 언론 동향 분석 전담 수석 AI 정책분석관입니다.
제공된 기사 목록의 본문을 분석하여 강원도 행정/정책 현안 뉴스 스크랩 보고서를 작성하세요.

[수행 지침]
1. 뉴스 선별 (20~25건 최종 선별):
   - 핵심 키워드: 강원특별법, 특별법, 강원도지사, 데이터센터, 반도체, 바이오, 강원도 현안, SOC, 특례, 도정, 도지사, 도의회, 과학기술원
   - 지역 언론사(강원일보, 강원도민일보, G1방송) 기사 가중치 부여 정렬
   - 제외: 기상, 날씨, 단순 사건/사고(음주운전, 마약, 절도), 타지역 단순 뉴스, 소방, 재난뉴스, 상 수상 등

2. 4대 카테고리 분류:
   - "core_issues": 핵심현안 (3~5건) - 강원특별법, 도지사, 산업, SOC, 정책, 강원도청, 우상호, 특례 등
   - "general_issues": 일반이슈 (5~6건) - 강원 행정,경제,정치 일반
   - "local_issues": 시군이슈 - 강원 18개 시군( '춘천', '원주', '강릉', '동해', '태백', '속초', '삼척', '홍천', '횡성', '영월', '평창', '정선', '철원', '화천', '양구', '인제', '고성', '양양') 지역명 제목에 명시 기사
   - "social_culture_edu": 사회/문화/교육 이슈 - 도내 교육, 문화, 복지, 대학, 사회란 뉴스

3. 스마트 요약 및 브리핑:
   - "today_briefing": Top 1, 2 기사를 바탕으로 도정 시사점 중심 오늘의 종합 브리핑 작성 (공백 포함 300자 내외).
   - "summary": 각 선별 기사별 핵심 스마트 요약 (공백 포함 250~300자).

[출력 형식]
반드시 아래 JSON 구조로만 답변하세요:
{
  "today_briefing": "오늘의 핵심 브리핑 내용 (300자 내외)...",
  "categories": {
    "core_issues": [
      { "id": 1, "pressName": "언론사", "title": "제목", "pubDate": "날짜", "link": "URL", "summary": "스마트 요약 (300자)" }
    ],
    "general_issues": [],
    "local_issues": [],
    "social_culture_edu": []
  }
}
`;

  const payload = {
    contents: [
      { parts: [{ text: systemPrompt + "\n\n[분석할 기사 목록]\n" + JSON.stringify(articlesWithContent) }] }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json"
    }
  };

  let lastError = null;

  for (const modelName of modelsToTry) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + apiKey;

    for (let retry = 1; retry <= 3; retry++) {
      console.log('🤖 Gemini AI [' + modelName + '] 분석 요청 중... (시도 ' + retry + '/3)');

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          const jsonResponse = await response.json();
          const candidate = jsonResponse.candidates && jsonResponse.candidates[0];
          if (candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]) {
            console.log('✅ Gemini AI 분석 완료! (' + modelName + ')');
            return JSON.parse(candidate.content.parts[0].text);
          }
        } else if (response.status === 503) {
          console.log('⚠️ HTTP 503 (서버 과부하) 대기 중... (' + (retry * 3) + '초 후 재시도)');
          await sleep(retry * 3000);
        } else {
          const errText = await response.text();
          lastError = 'Gemini API 오류 [HTTP ' + response.status + ']: ' + errText;
          break;
        }
      } catch (err) {
        lastError = 'Gemini 처리 예외: ' + err.message;
        break;
      }
    }
  }

  throw new Error('❌ Gemini AI 분석 실패: ' + lastError);
}

function buildHtmlEmailBody(aiResult, todayStr) {
  const briefing = aiResult.today_briefing || '오늘의 주요 브리핑 내용이 없습니다.';
  const cats = aiResult.categories || {};

  const coreList = cats.core_issues || [];
  const generalList = cats.general_issues || [];
  const localList = cats.local_issues || [];
  const eduList = cats.social_culture_edu || [];

  const renderTocItem = (item) => `
    <li style="margin-bottom: 8px; font-size: 15px; line-height: 1.5;">
      <span style="display: inline-block; background-color: #f1f5f9; color: #334155; font-size: 12px; font-weight: 700; padding: 2px 7px; border-radius: 4px; margin-right: 6px;">${item.pressName}</span>
      <a href="${item.link}" target="_blank" style="color: #0284c7; text-decoration: none; font-weight: 700;">${item.title}</a>
      <span style="color: #94a3b8; font-size: 12px; margin-left: 4px;">(${item.pubDate})</span>
    </li>
  `;

  const renderSummaryCard = (item, categoryColor, categoryBg) => `
    <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-left: 5px solid ${categoryColor}; border-radius: 8px; padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.03);">
      <div style="font-size: 17px; font-weight: 800; color: #0f172a; margin-bottom: 8px; line-height: 1.4;">
        <span style="background-color: ${categoryBg}; color: ${categoryColor}; font-size: 13px; font-weight: 700; padding: 3px 10px; border-radius: 12px; margin-right: 8px; display: inline-block; vertical-align: middle;">${item.pressName}</span>
        <a href="${item.link}" target="_blank" style="color: #0f172a; text-decoration: none; vertical-align: middle;">${item.title}</a>
      </div>
      <div style="font-size: 14px; color: #334155; line-height: 1.65; background-color: #f8fafc; border-radius: 6px; padding: 12px 14px; margin-top: 10px; border: 1px solid #f1f5f9;">
        <strong style="color: ${categoryColor};">💡 핵심 요약:</strong> ${item.summary}
      </div>
    </div>
  `;

  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif; color: #1e293b; background-color: #f1f5f9; padding: 24px 12px; margin: 0;">
    <div style="max-width: 820px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.08);">
      <div style="background: linear-gradient(135deg, #047857 0%, #0369a1 50%, #1e3a8a 100%); color: #ffffff; padding: 36px 28px;">
        <div style="font-size: 13px; font-weight: 800; letter-spacing: 1.5px; opacity: 0.9; text-transform: uppercase; margin-bottom: 6px;">Gangwon State Policy & Press Briefing</div>
        <h1 style="margin: 0; font-size: 25px; font-weight: 800; line-height: 1.3;">${todayStr} 강원특별자치도 현안 뉴스 스크랩</h1>
      </div>
      <div style="padding: 28px 24px;">
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-left: 6px solid #059669; border-radius: 10px; padding: 22px; margin-bottom: 28px;">
          <h2 style="margin-top: 0; margin-bottom: 12px; font-size: 19px; color: #065f46; font-weight: 800;">📌 1. 오늘의 핵심 브리핑 (Top Issues)</h2>
          <p style="margin: 0; font-size: 15px; line-height: 1.75; color: #0f172a; white-space: pre-line; font-weight: 500;">${briefing}</p>
        </div>
        <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 22px; margin-bottom: 32px;">
          <h2 style="margin-top: 0; font-size: 19px; color: #1e3a8a; border-bottom: 2px solid #2563eb; padding-bottom: 10px; font-weight: 800; margin-bottom: 16px;">📋 2. 기사 목차 (카테고리별 정렬)</h2>
          <h3 style="color: #2563eb; font-size: 16px; margin: 14px 0 8px 0; font-weight: 800;">(1) 핵심현안 (${coreList.length}건)</h3>
          <ol style="padding-left: 20px; margin: 0;">${coreList.map(renderTocItem).join('')}</ol>
          <h3 style="color: #0284c7; font-size: 16px; margin: 18px 0 8px 0; font-weight: 800;">(2) 일반이슈 (${generalList.length}건)</h3>
          <ol style="padding-left: 20px; margin: 0;">${generalList.map(renderTocItem).join('')}</ol>
          <h3 style="color: #059669; font-size: 16px; margin: 18px 0 8px 0; font-weight: 800;">(3) 시군이슈 (${localList.length}건)</h3>
          <ol style="padding-left: 20px; margin: 0;">${localList.map(renderTocItem).join('')}</ol>
          <h3 style="color: #0d9488; font-size: 16px; margin: 18px 0 8px 0; font-weight: 800;">(4) 사회 / 문화 / 교육 이슈 (${eduList.length}건)</h3>
          <ol style="padding-left: 20px; margin: 0;">${eduList.map(renderTocItem).join('')}</ol>
        </div>
        <div>
          <h2 style="margin-top: 0; font-size: 20px; color: #0f172a; border-bottom: 2px solid #059669; padding-bottom: 10px; margin-bottom: 20px; font-weight: 800;">🔍 3. 기사 카테고리별 스마트 요약</h2>
          ${coreList.length > 0 ? `<h3 style="color: #2563eb; font-size: 18px; margin: 24px 0 12px 0; font-weight: 800; border-left: 4px solid #2563eb; padding-left: 8px;">■ 핵심현안</h3>` + coreList.map(item => renderSummaryCard(item, '#2563eb', '#eff6ff')).join('') : ''}
          ${generalList.length > 0 ? `<h3 style="color: #0284c7; font-size: 18px; margin: 24px 0 12px 0; font-weight: 800; border-left: 4px solid #0284c7; padding-left: 8px;">■ 일반이슈</h3>` + generalList.map(item => renderSummaryCard(item, '#0284c7', '#f0f9ff')).join('') : ''}
          ${localList.length > 0 ? `<h3 style="color: #059669; font-size: 18px; margin: 24px 0 12px 0; font-weight: 800; border-left: 4px solid #059669; padding-left: 8px;">■ 시군이슈</h3>` + localList.map(item => renderSummaryCard(item, '#059669', '#ecfdf5')).join('') : ''}
          ${eduList.length > 0 ? `<h3 style="color: #0d9488; font-size: 18px; margin: 24px 0 12px 0; font-weight: 800; border-left: 4px solid #0d9488; padding-left: 8px;">■ 사회/문화/교육</h3>` + eduList.map(item => renderSummaryCard(item, '#0d9488', '#f0fdfa')).join('') : ''}
        </div>
      </div>
      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px; text-align: center; font-size: 13px; color: #64748b;">
        강원특별자치도 AI 정책분석관 자동화 보고서 (GitHub Actions)
      </div>
    </div>
  </body>
  </html>
  `;
}

async function sendEmail(subject, htmlContent) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SENDER_EMAIL,
      pass: process.env.SENDER_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `"강원특별자치도 AI 정책분석관" <${process.env.SENDER_EMAIL}>`,
    to: process.env.TARGET_EMAIL,
    subject: subject,
    html: htmlContent
  });
}

// 📲 텔레그램 전송 전용 함수
async function sendTelegramMessage(aiResult, todayStr) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('ℹ️ TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 설정되지 않아 텔레그램 발송을 건너뜁니다.');
    return;
  }

  const briefing = aiResult.today_briefing || '';
  const cats = aiResult.categories || {};

  let msg = `🏛 <b>[강원특별자치도] ${todayStr} 현안 브리핑</b>\n\n`;
  if (briefing) {
    msg += `📌 <b>오늘의 핵심 브리핑</b>\n${briefing}\n\n`;
  }

  const renderSection = (title, list) => {
    if (!list || list.length === 0) return '';
    let section = `<b>■ ${title}</b>\n`;
    list.forEach((item, i) => {
      section += `${i + 1}. [${item.pressName}] <a href="${item.link}">${item.title}</a>\n`;
    });
    return section + '\n';
  };

  msg += renderSection('핵심현안', cats.core_issues);
  msg += renderSection('일반이슈', cats.general_issues);
  msg += renderSection('시군이슈', cats.local_issues);
  msg += renderSection('사회/문화/교육', cats.social_culture_edu);

  const telegramUrl = 'https://api.telegram.org/bot' + token + '/sendMessage';
  
  try {
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (response.ok) {
      console.log('🎉 [성공] 텔레그램 브리핑 메시지 발송 완료!');
    } else {
      const errText = await response.text();
      console.error('⚠️ 텔레그램 발송 실패:', errText);
    }
  } catch (err) {
    console.error('⚠️ 텔레그램 발송 요청 중 예외 발생:', err.message);
  }
}

async function runGangwonNewsBot() {
  console.log('🚀 강원특별자치도 현안 뉴스 스크랩 봇 실행 시작...');

  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(now);

  try {
    const rawArticles = await collectNaverNews();
    if (rawArticles.length === 0) {
      console.log('⚠️ 수집된 뉴스가 없습니다.');
      return;
    }

    const articlesWithContent = await fetchArticleFullText(rawArticles);
    const aiResult = await processNewsWithGeminiAI(articlesWithContent);
    const htmlBody = buildHtmlEmailBody(aiResult, todayStr);

    // 1. 이메일 보고서 발송
    await sendEmail(`[강원특별자치도] ${todayStr} 현안 뉴스 스크랩 보고서`, htmlBody);
    console.log(`🎉 [성공] ${process.env.TARGET_EMAIL} 주소로 스크랩 보고서 전송이 완료되었습니다.`);

    // 2. 텔레그램 브리핑 발송
    await sendTelegramMessage(aiResult, todayStr);

  } catch (e) {
    console.error(`❌ 오류 발생: ${e.toString()}`);
    try {
      await sendEmail(`[오류 알림] 강원 뉴스 스크랩 봇 실행 실패 (${todayStr})`, `<p>오류 내용: ${e.toString()}</p>`);
    } catch (mailErr) {
      console.error(`❌ 오류 알림 메일 발송 실패: ${mailErr.message}`);
    }
    process.exit(1);
  }
}

runGangwonNewsBot();
