import type { NodeModel } from '@/api/types'
import { cn } from '@/lib/utils'
import asusFace from '@/assets/faces/asus-ascent-gx10.jpg'
import dellFace from '@/assets/faces/dell-pro-max-gb10.jpg'
import sparkFace from '@/assets/faces/dgx-spark.jpg'

// Fronts photographed on the real rack, straightened and cropped to 1:3 (units stand on end).
const FACES: Record<NodeModel, string> = {
  'DGX Spark FE': sparkFace,
  'Dell Pro Max GB10': dellFace,
  'ASUS GX10': asusFace,
}

/** The unit's front panel as seen in the rack. */
export function Faceplate({ model, className }: { model: NodeModel; className?: string }) {
  return <img src={FACES[model]} alt="" draggable={false} width={200} height={600} className={cn('aspect-[1/3] rounded-[3px] object-cover select-none', className)} />
}
