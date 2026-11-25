import type { NoteBlock } from "./tokenize";

const mk = (prefix: string, texts: string[]): NoteBlock[] => texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text }));

/** Second fixture set: Chinese, Korean, and an English note with sibling bullets, short blocks, acronyms and money. */
export const EXTRA_NOTES: Record<string, NoteBlock[]> = {
  zh: mk("zh", [
    "大家好，今天我将汇报本季度的业绩、产品路线图和招聘计划。",
    "第一季度收入增长了20%，主要得益于大客户的续约。",
    "客户流失率从4.5%下降到3%，因为我们重新设计了新用户引导流程。",
    "最大的风险是推理服务依赖单一的云厂商。",
    "为了降低风险，我们将在2026年9月之前迁移到多云架构。",
    "路线图有三个支柱：可靠性、速度和协作。",
    "年底前我们计划招聘12名工程师和4名设计师。",
    "谢谢大家，幻灯片和演示录像明天上午发给你们。",
  ]),
  ko: mk("ko", [
    "안녕하세요, 오늘은 분기 실적과 로드맵, 채용 계획을 발표하겠습니다.",
    "첫 번째 분기 매출은 대기업 고객의 계약 갱신 덕분에 20퍼센트 성장했습니다.",
    "온보딩을 새로 만든 뒤 이탈률이 4.5퍼센트에서 3퍼센트로 떨어졌습니다.",
    "가장 큰 위험은 추론을 하나의 클라우드 업체에 의존한다는 점입니다.",
    "이를 줄이기 위해 2026년 9월까지 멀티 클라우드 구조로 이전하겠습니다.",
    "로드맵에는 안정성, 속도, 협업이라는 세 가지 축이 있습니다.",
    "연말까지 엔지니어 12명과 디자이너 4명을 채용할 계획입니다.",
    "감사합니다. 슬라이드와 데모 녹화는 내일 아침에 공유하겠습니다.",
  ]),
  en2: mk("x", [
    "Agenda for today: security review, growth numbers and the hiring plan.",
    "We passed SOC 2 in the third quarter and ISO 27001 is planned for Q1.",
    "ARR reached $4.2M, up 38 percent year over year.",
    "Revenue in Q4 was $1.1M with enterprise accounts driving most of it.",
    "Plan A: launch the mobile app in March with a small beta group.",
    "Plan B: delay the mobile app until June and fix performance first.",
    "Support tickets dropped from 900 to 450 per month after the new help center.",
    "Hiring: two data engineers and one security lead by the fifth of May.",
    "Questions?",
    "Next steps: send the board deck, schedule the customer calls, and update the roadmap.",
  ]),
};
