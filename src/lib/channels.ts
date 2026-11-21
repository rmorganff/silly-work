/** The Slack channels the Work routines read, always by ID (private channels are not found by name). Ronnie's own Slack user id is fixed. */
export const RONNIE_SLACK = 'UCTAVAFSA';

export interface Channel { id: string; name: string; /** how the card may call it: the board's writing guard refuses the real names of two of them */ label: string; kind?: 'management' | 'lp' }
export const CHANNELS: Channel[] = [
  { id: 'C0101QQN8SY', name: 'recruitment-retail', label: 'recruitment-retail' },
  { id: 'C023M37B8UA', name: 'recruitment-distribution', label: 'recruitment-distribution' },
  { id: 'C03HLE6FP1N', name: 'shop-area-manager-recruitment', label: 'shop-area-manager-recruitment' },
  { id: 'C05L4EP48QH', name: 'recruitment-coordinator', label: 'recruitment-coordinator' },
  { id: 'C05HQL9Q955', name: 'internal-transfers', label: 'internal-transfers' },
  { id: 'C06AQD5H5RT', name: 'training-team', label: 'training-team' },
  { id: 'C0135DZ9G3S', name: 'retail-elearning', label: 'retail-elearning' },
  { id: 'C0B6Y4WSELF', name: 'distribution-elearning', label: 'distribution-elearning' },
  { id: 'CCTAXN4S2', name: 'apprenticeship', label: 'apprenticeship' },
  { id: 'C09FB3DFFA5', name: 'grad_programme', label: 'grad_programme' },
  { id: 'C087P1BDBFH', name: 'loss-prevention', label: 'loss-prevention' },
  { id: 'C06MA3XB6M6', name: 'private-farmfoods-auror', label: 'private LP channel', kind: 'lp' },
  { id: 'C042HH84F8S', name: 'shop-refused-help', label: 'shop-refused-help' },
  { id: 'C09C7RE8PPX', name: 'project-mss', label: 'project-mss' },
  { id: 'C09NSF5K7C6', name: 'yoobic', label: 'yoobic' },
  { id: 'C02FEF0TVRA', name: 'to-do', label: 'to-do' },
  { id: 'C0692KPGJUR', name: 'losjefes', label: 'management channel', kind: 'management' },
];
export const RETAIL_BOARD_ID = '1232451925';
export const LP_BOARD_ID = '8247581349';
