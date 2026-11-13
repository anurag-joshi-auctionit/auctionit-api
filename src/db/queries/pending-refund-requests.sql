SELECT
    PayId AS PayEMDId,
    CreatedOn AS RegDate,
    Remarks AS Remark,
    Amount AS RefBallance,
    IsCancelRequest,
    IsRejectBankDetails
FROM
    tbl_Data_PayEMD
WHERE
    ISNULL (transactionId, '') = ''
    AND BidderCompId = 1118