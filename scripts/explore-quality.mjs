function cleanText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

const researchSourceKindPattern =
  /^(?:research|paper|academic|journal|preprint)$/iu;
const researchUrlPattern =
  /(?:arxiv\.org|openreview\.net|aclanthology\.org|paperswithcode\.com|lesswrong\.com|alignmentforum\.org|\/research(?:\/|$)|\/papers?(?:\/|$)|\/publications?(?:\/|$))/iu;
const researchNarrativePattern =
  /(?:论文|研究(?:结果|发现|方法)?|实验(?:结果|设置)?|基准|评测|复现|训练方法|模型架构|仿真|定理|监控器|paper|study|research(?:ers?| result)?|experiment|benchmark|evaluation|simulation|theorem|monitor(?:ing)?)/iu;
const realWorldActionPattern =
  /(?:正式发布|上线|开放(?:使用|下载|API)|部署|投产|采用|接入|集成|签约|客户|订单|收入|定价|融资|收购|监管决定|开源|release[ds]?|launch(?:ed|es)?|ship(?:ped|s)?|deploy(?:ed|ment|s)?|adopt(?:ed|ion|s)?|rollout|available|production|integrat(?:ed|ion|es)|customer|contract|revenue|pricing|funding|acqui(?:red|sition)|open[- ]source)/iu;
const independentValidationPattern =
  /(?:独立复现|重复实验|复现(?:结果|成功)|第三方验证|独立验证|确认了该结果|replicat(?:ed|ion)|reproduc(?:ed|ibility|tion)|independent(?:ly)? (?:verified|validated|confirmed)|confirmed the (?:finding|result))/iu;

export function isResearchLikeEvidence(evidence) {
  const sourceKind = cleanText(evidence?.sourceKind);
  const url = cleanText(evidence?.url);
  return (
    researchSourceKindPattern.test(sourceKind) ||
    researchUrlPattern.test(url)
  );
}

function evidenceText(evidence) {
  return [
    evidence?.title,
    evidence?.summary,
    evidence?.takeaway,
    evidence?.researchClaim,
    evidence?.researchComparisons,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

function publisherKey(evidence) {
  return cleanText(evidence?.sourcePublisher ?? evidence?.sourceName)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function eventText(event) {
  return [
    event?.changedVariable,
    event?.signal?.title,
    event?.signal?.summary,
    event?.signal?.why,
    event?.signal?.impact,
    event?.signal?.shiftFrom,
    event?.signal?.shiftTo,
    event?.signal?.crossValidation,
    event?.signal?.article?.lead,
    ...(event?.signal?.article?.sections ?? []).flatMap((section) => [
      section?.heading,
      section?.body,
    ]),
    event?.signal?.article?.outlook,
    event?.title,
    event?.thesis,
    event?.whyNow,
    event?.counterpoint,
    event?.crossValidation,
    event?.article?.lead,
    ...(event?.article?.sections ?? []).flatMap((section) => [
      section?.heading,
      section?.body,
    ]),
    event?.article?.outlook,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

export function qualifiesExploreEvidenceBundle(event, evidence = []) {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;

  const researchEvidence = evidence.filter(isResearchLikeEvidence);
  const evidencePublishers = new Set(evidence.map(publisherKey).filter(Boolean));
  const researchPublishers = new Set(
    researchEvidence.map(publisherKey).filter(Boolean),
  );
  const joinedText = `${eventText(event)} ${evidence
    .map(evidenceText)
    .join(" ")}`;
  const hasRealitySignal = evidence.some(
    (item) =>
      !isResearchLikeEvidence(item) &&
      realWorldActionPattern.test(evidenceText(item)),
  );
  const hasIndependentValidation = evidence.some(
    (item) =>
      !isResearchLikeEvidence(item) &&
      evidencePublishers.size > 1 &&
      (!researchPublishers.size ||
        !researchPublishers.has(publisherKey(item))) &&
      independentValidationPattern.test(evidenceText(item)),
  );

  // Research may support an Explore thesis, but it cannot be the product by
  // itself. Blog-only technical explainers are also treated as research-led.
  const isResearchLed =
    researchEvidence.length > 0 ||
    (evidence.every(
      (item) => cleanText(item?.sourceKind).toLowerCase() === "blog",
    ) &&
      researchNarrativePattern.test(joinedText) &&
      !hasRealitySignal);

  return !isResearchLed || hasRealitySignal || hasIndependentValidation;
}
