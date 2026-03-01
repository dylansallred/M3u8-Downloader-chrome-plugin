import type { ReactNode } from 'react';

interface ViewContainerProps {
  children: ReactNode;
}

export function ViewContainer({ children }: ViewContainerProps) {
  return (
    <main className="flex-1 overflow-auto">
      <div className="max-w-[960px] mx-auto px-6 py-4">
        {children}
      </div>
    </main>
  );
}
