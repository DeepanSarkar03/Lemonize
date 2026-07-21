import { cn } from '@/utils/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const badgeStyles = cva(
  'inline-flex items-center gap-2 rounded-full border font-mono font-medium uppercase tracking-[0.08em] [&>svg]:h-3 [&>svg]:w-3',
  {
    variants: {
      size: {
        sm: 'py-0.5 text-xs',
        md: 'py-0.5 text-sm',
        lg: 'py-1 text-sm',
      },
      prefixIcon: { true: '', false: '' },
      suffixIcon: { true: '', false: '' },
      color: {
        gray: 'border-line bg-paper text-ink-600',
        primary: 'border-citron/50 bg-lemon-bg text-lemon-text',
        error: 'border-pastel-redText/20 bg-pastel-redBg text-pastel-redText',
        warning: 'border-[#9B6A22]/20 bg-[#F6EBCF] text-[#76501B]',
        success: 'border-pastel-greenText/20 bg-pastel-greenBg text-pastel-greenText',
        cyan: 'border-pastel-blueText/20 bg-pastel-blueBg text-pastel-blueText',
        sky: 'border-pastel-blueText/20 bg-pastel-blueBg text-pastel-blueText',
        blue: 'border-pastel-blueText/20 bg-pastel-blueBg text-pastel-blueText',
        violet: 'border-[#675A8A]/20 bg-[#EBE6F3] text-[#675A8A]',
        purple: 'border-[#675A8A]/20 bg-[#EBE6F3] text-[#675A8A]',
        pink: 'border-pastel-redText/20 bg-pastel-redBg text-pastel-redText',
        rose: 'border-pastel-redText/20 bg-pastel-redBg text-pastel-redText',
        orange: 'border-[#9B6A22]/20 bg-[#F6EBCF] text-[#76501B]',
      },
    },
    compoundVariants: [
      {
        prefixIcon: true,
        suffixIcon: true,
        size: 'sm',
        className: 'px-1.5',
      },
      {
        prefixIcon: true,
        suffixIcon: true,
        size: 'md',
        className: 'px-2',
      },
      {
        prefixIcon: true,
        suffixIcon: true,
        size: 'lg',
        className: 'px-2.5',
      },
      {
        prefixIcon: false,
        suffixIcon: false,
        size: 'sm',
        className: 'px-2',
      },
      {
        prefixIcon: false,
        suffixIcon: false,
        size: 'md',
        className: 'px-2.5',
      },
      {
        prefixIcon: false,
        suffixIcon: false,
        size: 'lg',
        className: 'px-3',
      },
      {
        prefixIcon: true,
        suffixIcon: false,
        size: 'sm',
        className: 'pr-2 pl-1.5',
      },
      {
        prefixIcon: true,
        suffixIcon: false,
        size: 'md',
        className: 'pr-2.5 pl-2',
      },
      {
        prefixIcon: true,
        suffixIcon: false,
        size: 'lg',
        className: 'pr-3 pl-2.5',
      },
      {
        prefixIcon: false,
        suffixIcon: true,
        size: 'sm',
        className: 'pr-1.5 pl-2',
      },
      {
        prefixIcon: false,
        suffixIcon: true,
        size: 'md',
        className: 'pr-2 pl-2.5',
      },
      {
        prefixIcon: false,
        suffixIcon: true,
        size: 'lg',
        className: 'pr-2.5 pl-3',
      },
    ],
    defaultVariants: {
      size: 'sm',
      color: 'primary',
    },
  },
);

type PropsType = ComponentProps<'span'> &
  Omit<VariantProps<typeof badgeStyles>, 'prefixIcon' | 'suffixIcon'> & {
    prefixIcon?: React.ReactNode;
    suffixIcon?: React.ReactNode;
  };

export function Badge({
  color,
  size,
  className,
  prefixIcon,
  suffixIcon,
  children,
  ...props
}: PropsType) {
  return (
    <span
      className={cn(
        badgeStyles({
          color,
          size,
          prefixIcon: Boolean(prefixIcon),
          suffixIcon: Boolean(suffixIcon),
        }),
        className,
      )}
      {...props}
    >
      {prefixIcon}
      {children}
      {suffixIcon}
    </span>
  );
}
