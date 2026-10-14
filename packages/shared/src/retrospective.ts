// 실행이 끝난 뒤 모델이 쓴 회고. 숫자 보고(RunReport)와 달리 모델의 해석이다.
export interface Retrospective {
  summary: string;
  wentWell: string[];
  problems: string[];
  nextSteps: string[];
}
