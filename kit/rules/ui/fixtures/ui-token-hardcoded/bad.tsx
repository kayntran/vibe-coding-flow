export function Tong({ soTien }: { soTien: string }) {
  return (
    <div className="p-4 bg-[#1a2b3c] text-[13px]">
      <span style={{ color: '#ff0000', padding: '12px', width: '320px' }}>{soTien}</span>
    </div>
  )
}
