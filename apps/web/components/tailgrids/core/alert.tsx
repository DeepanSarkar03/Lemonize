'use client';

import { cn } from '@/utils/cn';
import { CheckCircle1, InfoCircle, InfoTriangle, Xmark } from '@tailgrids/icons';
import { cva, type VariantProps } from 'class-variance-authority';
import { createContext, use } from 'react';
import { Heading, HeadingProps } from 'react-aria-components';

const AlertContext = createContext<{ status: AlertStatus }>({
  status: 'default',
});

// Alert

const alertStyles = cva(
  'relative w-full flex items-start gap-3 max-w-4xl rounded-lg border px-5 py-4',
  {
    variants: {
      status: {
        default: 'border-line bg-surface',
        success: 'border-pastel-greenText/20 bg-pastel-greenBg',
        warning: 'border-citron/60 bg-lemon-bg',
        error: 'border-pastel-redText/20 bg-pastel-redBg',
        info: 'border-pastel-blueText/20 bg-pastel-blueBg',
      },
    },
    defaultVariants: {
      status: 'default',
    },
  },
);

export type AlertStatus = NonNullable<VariantProps<typeof alertStyles>['status']>;

export interface AlertProps extends React.ComponentProps<'div'> {
  status?: AlertStatus;
}

export function Alert({ className, status = 'default', children, ...props }: AlertProps) {
  return (
    <AlertContext.Provider value={{ status }}>
      <div
        data-slot="alert"
        data-status={status}
        role="alert"
        className={cn(alertStyles({ status }), className)}
        {...props}
      >
        {children}
      </div>
    </AlertContext.Provider>
  );
}

Alert.displayName = 'Alert';

// Alert Indicator

const indicatorStyles = cva(
  'flex h-7 w-7 items-center justify-center rounded-lg text-white [&>svg]:h-4 [&>svg]:w-4',
  {
    variants: {
      status: {
        default: 'bg-carbon',
        success: 'bg-pastel-greenText',
        warning: 'bg-lemon-text',
        error: 'bg-pastel-redText',
        info: 'bg-pastel-blueText',
      },
    },
    defaultVariants: {
      status: 'default',
    },
  },
);

export type AlertIndicatorProps = React.ComponentProps<'span'>;

export function AlertIndicator({ className, children, ...props }: AlertIndicatorProps) {
  const { status } = use(AlertContext);

  const loadIcon = () => {
    switch (status) {
      case 'success':
        return <CheckCircle1 aria-hidden="true" focusable="false" />;
      case 'warning':
        return <InfoTriangle aria-hidden="true" focusable="false" />;
      case 'error':
        return <Xmark aria-hidden="true" focusable="false" />;
      case 'info':
      default:
        return <InfoCircle aria-hidden="true" focusable="false" />;
    }
  };

  return (
    <span
      data-slot="alert-indicator"
      data-status={status}
      aria-hidden="true"
      role="presentation"
      className={cn(indicatorStyles({ status }), className)}
      {...props}
    >
      {children ?? loadIcon()}
    </span>
  );
}

AlertIndicator.displayName = 'AlertIndicator';

// Alert Content

export type AlertContentProps = React.ComponentProps<'div'>;

export function AlertContent({ className, ...props }: AlertContentProps) {
  return (
    <div
      data-slot="alert-content"
      className={cn('flex-1 flex flex-col items-start gap-1', className)}
      {...props}
    />
  );
}

AlertContent.displayName = 'AlertContent';

// Alert Title

const titleStyles = cva('font-semibold leading-6 tracking-[-0.2px]', {
  variants: {
    status: {
      default: 'text-ink-900',
      success: 'text-pastel-greenText',
      warning: 'text-lemon-text',
      error: 'text-pastel-redText',
      info: 'text-pastel-blueText',
    },
  },
  defaultVariants: {
    status: 'default',
  },
});

export type AlertTitleProps = HeadingProps;

export function AlertTitle({ className, children, level = 4, ...props }: AlertTitleProps) {
  const { status } = use(AlertContext);

  return (
    <Heading
      data-slot="alert-title"
      data-status={status}
      level={level}
      className={cn(titleStyles({ status }), className)}
      {...props}
    >
      {children}
    </Heading>
  );
}

AlertTitle.displayName = 'AlertTitle';

// Alert Description

export type AlertDescriptionProps = React.ComponentProps<'div'>;

export function AlertDescription({ className, children, ...props }: AlertDescriptionProps) {
  const { status } = use(AlertContext);

  return (
    <div
      data-slot="alert-description"
      data-status={status}
      className={cn('text-sm leading-5 tracking-[-0.2px] text-ink-600', className)}
      {...props}
    >
      {children}
    </div>
  );
}

AlertDescription.displayName = 'AlertDescription';
