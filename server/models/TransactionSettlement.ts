import { groupBy } from 'lodash';

import { TransactionKind } from '../constants/transaction-kind';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model, Op, Transaction as SQLTransaction } from '../lib/sequelize';

import Collective from './Collective';
import Transaction from './Transaction';

export enum TransactionSettlementStatus {
  OWED = 'OWED',
  INVOICED = 'INVOICED',
  SETTLED = 'SETTLED',
}

interface TransactionSettlementAttributes {
  TransactionGroup: string;
  kind: TransactionKind;
  status: TransactionSettlementStatus;
  ExpenseId: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

interface TransactionSettlementCreateAttributes {
  TransactionGroup: string;
  kind: TransactionKind;
  status: TransactionSettlementStatus;
  ExpenseId?: number;
}

class TransactionSettlement
  extends Model<TransactionSettlementAttributes, TransactionSettlementCreateAttributes>
  implements TransactionSettlementAttributes {
  TransactionGroup: string;
  kind: TransactionKind;
  status: TransactionSettlementStatus;
  ExpenseId: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  // ---- Instance methods ----

  /**
   * Reverts a settlement after a refund
   */
  async revertSettlementForRefund(refundTransaction): Promise<void> {
    if (this.status === TransactionSettlementStatus.OWED) {
      // Transaction has not been accounted for yet, we can directly delete it
      await this.destroy();
    } else if (this.status === TransactionSettlementStatus.INVOICED) {
      // Remove transaction from the invoice if not paid already
      await sequelize.transaction(async sqlTransaction => {
        const expense = await this.getExpense({ include: [{ association: 'items' }], transaction: sqlTransaction });
        const item = expense.items.find(item => false); // TODO(LedgerRefactor): find a way to retrieve the correct item
        await expense.update({ amount: expense.amount - item.amount }, { transaction: sqlTransaction });
        await item.destroy({ transaction: sqlTransaction });
      });
    } else if (this.status === TransactionSettlementStatus.SETTLED) {
      // We have to revert the platform tip and mark it as owed from Open Collective to the host
      // TODO
      await TransactionSettlement.createForTransaction(refundTransaction);
    } else {
      throw new Error(`Don't know how to revert this status: ${this.status}`);
    }
  }

  // ---- Static methods ----

  static async getAccountsWithOwedSettlements(): Promise<typeof Collective[]> {
    return sequelize.query(
      `
        SELECT c.*
        FROM "Collectives" c
        INNER JOIN "Transactions" t ON t."CollectiveId" = c.id
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."type" = 'CREDIT'
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        AND ts."status" = 'OWED'
        GROUP BY c.id
      `,
      {
        model: Collective,
        mapToModel: true,
      },
    );
  }

  static async getHostDebts(
    hostId: number,
    settlementStatus: TransactionSettlementStatus = undefined,
  ): Promise<typeof Transaction[]> {
    return sequelize.query(
      `
        SELECT t.*, ts.status as "settlementStatus"
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."type" = 'CREDIT'
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        ${settlementStatus ? 'AND ts."status" = :settlementStatus' : ''}
      `,
      {
        model: Transaction,
        mapToModel: true,
        replacements: { settlementStatus, hostId },
      },
    );
  }

  /**
   * Update
   */
  static async updateTransactionsSettlementStatus(
    transactions: typeof Transaction[],
    status: TransactionSettlementStatus,
    expenseId: number = undefined,
  ): Promise<void> {
    const newData = { status };
    if (expenseId !== undefined) {
      newData['ExpenseId'] = expenseId;
    }

    await TransactionSettlement.update(newData, {
      where: {
        [Op.or]: transactions.map(transaction => ({
          TransactionGroup: transaction.TransactionGroup,
          kind: transaction.kind,
        })),
      },
    });
  }

  static async createForTransaction(
    transaction: typeof Transaction,
    status = TransactionSettlementStatus.OWED,
    sqlTransaction: SQLTransaction = null,
  ): Promise<TransactionSettlement> {
    return TransactionSettlement.create(
      {
        TransactionGroup: transaction.TransactionGroup,
        kind: transaction.kind,
        status,
      },
      {
        transaction: sqlTransaction,
      },
    );
  }

  static async attachStatusesToTransactions(transactions: typeof Transaction[]): Promise<void> {
    const debts = transactions.filter(t => t.isDebt);
    const where = { [Op.or]: debts.map(t => ({ TransactionGroup: t.TransactionGroup, kind: t.kind })) };
    const settlements = await TransactionSettlement.findAll({ where });
    const groupedSettlements = groupBy(settlements, 'TransactionGroup');

    debts.forEach(transaction => {
      const settlement = groupedSettlements[transaction.TransactionGroup]?.find(s => transaction.kind === s.kind);
      transaction['dataValues']['settlementStatus'] = settlement?.status || null;
    });
  }
}

TransactionSettlement.init(
  {
    TransactionGroup: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    kind: {
      // Re-using the same ENUM than `Transactions` so that we don't have to maintain two of them.
      // We'll have a better way of doing this with https://github.com/sequelize/sequelize/issues/2577
      type: '"public"."enum_Transactions_kind"',
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionSettlementStatus)),
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Expenses', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'TransactionSettlements',
    paranoid: true,
  },
);

export default TransactionSettlement;
